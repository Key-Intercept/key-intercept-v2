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
                requestBatteryOptimizationExemption()
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

    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
            appendLog("requested battery optimization exemption")
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
}
