package com.keyintercept.loopback

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }

        val statusText = TextView(this).apply {
            text = "Key Intercept Loopback is currently stopped"
        }

        val startButton = Button(this).apply {
            text = "Start Background Service"
            setOnClickListener {
                startService(Intent(this@MainActivity, LoopbackService::class.java).apply {
                    action = LoopbackService.ACTION_START
                })
                statusText.text = "Key Intercept Loopback is running in the background"
            }
        }

        val stopButton = Button(this).apply {
            text = "Stop Background Service"
            setOnClickListener {
                startService(Intent(this@MainActivity, LoopbackService::class.java).apply {
                    action = LoopbackService.ACTION_STOP
                })
                statusText.text = "Key Intercept Loopback is currently stopped"
            }
        }

        val batteryButton = Button(this).apply {
            text = "Fix Battery Optimization"
            setOnClickListener { requestBatteryOptimizationExemption() }
        }

        layout.addView(statusText)
        layout.addView(startButton)
        layout.addView(stopButton)
        layout.addView(batteryButton)
        setContentView(layout)
    }

    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        }
    }
}
