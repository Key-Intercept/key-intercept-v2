package com.keyintercept.loopback

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {
    private var statusText: TextView? = null
    private var logsText: TextView? = null
    private val recentLogs = ArrayDeque<String>()
    private var pendingStartAfterOptimization = false
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
                if (ensureBatteryOptimizationReady()) {
                    startLoopbackService()
                } else {
                    pendingStartAfterOptimization = true
                    statusText?.text = "Waiting for battery optimization exemption before starting"
                    appendLog("awaiting battery optimization exemption")
                }
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
    }

    override fun onStop() {
        runCatching { unregisterReceiver(statusReceiver) }
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        restorePersistedServiceStatus()
        if (pendingStartAfterOptimization) {
            if (isBatteryOptimizationExempt()) {
                pendingStartAfterOptimization = false
                appendLog("battery optimization exemption confirmed")
                startLoopbackService()
            } else {
                appendLog("battery optimization exemption still not granted")
            }
        }
    }

    private fun ensureBatteryOptimizationReady(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        if (isBatteryOptimizationExempt()) return true
        requestBatteryOptimizationExemption()
        return false
    }

    private fun isBatteryOptimizationExempt(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        return powerManager.isIgnoringBatteryOptimizations(packageName)
    }

    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
        }
        startActivity(intent)
        appendLog("requested battery optimization exemption")
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
