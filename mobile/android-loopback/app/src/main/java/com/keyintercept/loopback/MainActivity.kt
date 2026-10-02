package com.keyintercept.loopback

import android.Manifest
import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : ComponentActivity() {
    private var statusText: TextView? = null
    private var logsText: TextView? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val recentLogs = ArrayDeque<String>()
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        appendLog(
            if (granted) "notification permission granted"
            else "notification permission denied; foreground notification visibility may be limited"
        )
    }
    private val statusPoller = object : Runnable {
        override fun run() {
            restorePersistedServiceStatus()
            mainHandler.postDelayed(this, 1000)
        }
    }
    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != LoopbackService.ACTION_STATUS) return
            val state = intent.getStringExtra(LoopbackService.EXTRA_STATE) ?: "unknown"
            val message = intent.getStringExtra(LoopbackService.EXTRA_MESSAGE) ?: ""
            updateStatusFromState(state, message)
            appendLog("service:$state ${message.trim()}")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }

        val statusView = TextView(this).apply {
            text = "Key Intercept Loopback is currently stopped"
        }
        statusText = statusView
        val logsView = TextView(this).apply {
            text = "Logs will appear here"
            setPadding(0, 24, 0, 0)
        }
        logsText = logsView

        val startButton = Button(this).apply {
            text = "Start Background Service"
            setOnClickListener {
                requestNotificationPermissionIfNeeded()
                startLoopbackService()
                requestBatteryOptimizationExemptionIfNeeded()
            }
        }

        val stopButton = Button(this).apply {
            text = "Stop Background Service"
            setOnClickListener {
                runCatching {
                    startService(Intent(this@MainActivity, LoopbackService::class.java).apply {
                        action = LoopbackService.ACTION_STOP
                    })
                }.onSuccess {
                    statusText?.text = "Key Intercept Loopback is currently stopped"
                    appendLog("requested stop")
                }.onFailure { error ->
                    statusText?.text = "Failed to stop background service: ${error.message ?: "unknown error"}"
                    appendLog("stop failed: ${error.message ?: "unknown error"}")
                }
            }
        }

        layout.addView(statusView)
        layout.addView(startButton)
        layout.addView(stopButton)
        layout.addView(logsView)
        setContentView(layout)
        restorePersistedServiceStatus()
        refreshInitialStatus()
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(LoopbackService.ACTION_STATUS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(statusReceiver, filter)
        }
        mainHandler.post(statusPoller)
    }

    override fun onStop() {
        runCatching { unregisterReceiver(statusReceiver) }
        mainHandler.removeCallbacks(statusPoller)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        restorePersistedServiceStatus()
    }

    private fun isBatteryOptimizationExempt(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        return powerManager.isIgnoringBatteryOptimizations(packageName)
    }

    private fun requestBatteryOptimizationExemptionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (isBatteryOptimizationExempt()) {
            appendLog("battery optimization exemption already granted")
            return
        }
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
        }
        startActivity(intent)
        appendLog("requested battery optimization exemption")
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return
        }
        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun startLoopbackService() {
        runCatching {
            val intent = Intent(this@MainActivity, LoopbackService::class.java).apply {
                action = LoopbackService.ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(this@MainActivity, intent)
            } else {
                startService(intent)
            }
        }.onSuccess {
            statusText?.text = "Key Intercept Loopback is starting in the background"
            appendLog("requested start")
            verifyLoopbackStartupAsync()
        }.onFailure { error ->
            statusText?.text = "Failed to start background service: ${error.message ?: "unknown error"}"
            appendLog("start failed: ${error.message ?: "unknown error"}")
        }
    }

    private fun refreshInitialStatus() {
        if (isServiceRunning()) {
            statusText?.text = "Key Intercept Loopback is running in the background"
            appendLog("service detected as running")
        } else {
            statusText?.text = "Key Intercept Loopback is currently stopped"
        }
    }

    private fun isServiceRunning(): Boolean {
        val manager = getSystemService(ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION")
        return manager.getRunningServices(Int.MAX_VALUE)
            .any { it.service.className == LoopbackService::class.java.name }
    }

    private fun updateStatusFromState(state: String, message: String) {
        statusText?.text = when (state) {
            LoopbackService.STATE_RUNNING -> "Key Intercept Loopback is running in the background"
            LoopbackService.STATE_STARTING -> "Key Intercept Loopback is starting in the background"
            LoopbackService.STATE_STOPPED -> "Key Intercept Loopback is currently stopped"
            LoopbackService.STATE_ERROR -> "Key Intercept Loopback encountered an error"
            else -> "Key Intercept Loopback status: $state"
        }
        if (state == LoopbackService.STATE_ERROR && message.isNotBlank()) {
            statusText?.text = "${statusText?.text}: $message"
        }
    }

    private fun appendLog(line: String) {
        if (line.isBlank()) return
        while (recentLogs.size >= 12) {
            recentLogs.removeFirst()
        }
        recentLogs.addLast(line)
        logsText?.text = recentLogs.joinToString(separator = "\n")
    }

    private fun verifyLoopbackStartupAsync() {
        Thread {
            Thread.sleep(1800)
            val running = isServiceRunning()
            val healthOk = probeLoopbackHealth()
            runOnUiThread {
                when {
                    healthOk -> {
                        statusText?.text = "Key Intercept Loopback is running in the background"
                        appendLog("startup verification passed (health ok)")
                    }
                    running -> {
                        appendLog("service running but /health probe failed")
                    }
                    else -> {
                        statusText?.text = "Key Intercept Loopback failed to start"
                        appendLog("service process not running after start request")
                    }
                }
            }
        }.start()
    }

    private fun probeLoopbackHealth(): Boolean {
        return runCatching {
            val url = URL("http://127.0.0.1:${BuildConfig.LOOPBACK_PORT}/health")
            (url.openConnection() as HttpURLConnection).run {
                requestMethod = "GET"
                connectTimeout = 1000
                readTimeout = 1000
                connect()
                val ok = responseCode == 200
                disconnect()
                ok
            }
        }.getOrDefault(false)
    }

    private fun restorePersistedServiceStatus() {
        val prefs = getSharedPreferences(LoopbackService.PREFS_NAME, Context.MODE_PRIVATE)
        val state = prefs.getString(LoopbackService.PREF_STATE, null)
        val message = prefs.getString(LoopbackService.PREF_MESSAGE, "").orEmpty()
        if (!state.isNullOrBlank()) {
            updateStatusFromState(state, message)
        }
        val persistedLogs = prefs.getString(LoopbackService.PREF_LOGS, "").orEmpty()
            .lines()
            .filter { it.isNotBlank() }
        if (persistedLogs.isNotEmpty()) {
            recentLogs.clear()
            for (line in persistedLogs.takeLast(12)) {
                recentLogs.addLast(line)
            }
            logsText?.text = recentLogs.joinToString(separator = "\n")
        }
    }
}
