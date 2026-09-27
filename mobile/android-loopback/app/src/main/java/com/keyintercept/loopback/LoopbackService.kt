package com.keyintercept.loopback

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

class LoopbackService : Service() {
    companion object {
        const val ACTION_START = "com.keyintercept.loopback.START"
        const val ACTION_STOP = "com.keyintercept.loopback.STOP"
        private const val CHANNEL_ID = "key-intercept-loopback"
        private const val NOTIFICATION_ID = 1001
    }

    private val running = AtomicBoolean(false)
    private var serverThread: Thread? = null
    private var serverSocket: ServerSocket? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopServer()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            else -> startServer()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopServer()
        super.onDestroy()
    }

    private fun startServer() {
        if (running.get()) return
        runCatching {
            createNotificationChannel()
            val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Key Intercept Loopback")
                .setContentText("Key Intercept Loopback is running in the background")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .build()
            startForeground(NOTIFICATION_ID, notification)
        }.onFailure { err ->
            Log.e("KeyInterceptLoopback", "Failed to start foreground service", err)
            stopSelf()
            return
        }

        running.set(true)
        serverThread = Thread {
            val configuredPort = BuildConfig.LOOPBACK_PORT
                .takeIf { it in 1..65535 }
                ?: 35491
            runCatching {
                ServerSocket(configuredPort, 50, InetAddress.getByName("127.0.0.1")).use { server ->
                    serverSocket = server
                    while (running.get()) {
                        runCatching { server.accept() }
                            .onSuccess { socket -> handleClient(socket) }
                    }
                }
            }.onFailure { err ->
                Log.e("KeyInterceptLoopback", "Loopback server thread failed", err)
            }.also {
                serverSocket = null
            }
        }.also { it.start() }
    }

    private fun stopServer() {
        running.set(false)
        runCatching { serverSocket?.close() }
        serverSocket = null
        serverThread?.interrupt()
        serverThread = null
    }

    private fun handleClient(socket: Socket) {
        socket.use {
            val input = it.getInputStream().bufferedReader()
            val firstLine = input.readLine() ?: return
            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = input.readLine() ?: return
                if (line.isBlank()) break
                val split = line.split(":", limit = 2)
                if (split.size == 2) headers[split[0].trim().lowercase()] = split[1].trim()
            }

            val parts = firstLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0]
            val path = parts[1]
            val bodyLength = headers["content-length"]?.toIntOrNull() ?: 0
            val body = if (bodyLength > 0) {
                CharArray(bodyLength).also { input.read(it, 0, bodyLength) }.concatToString()
            } else ""

            val ownerId = configJson().optString("owner_discord_id")
            val requesterId = headers["x-discord-user-id"] ?: queryParam(path, "requester_id")

            val response = when {
                method == "GET" && path.startsWith("/health") -> httpResponse(200, "ok", "text/plain")
                method == "GET" && path.startsWith("/config") -> {
                    if (!canRead(ownerId, requesterId)) {
                        jsonError(403, "requester is not allowed to read config")
                    } else {
                        httpResponse(200, configJson().getJSONObject("config").toString())
                    }
                }
                method == "PUT" && path == "/config" -> {
                    val payload = JSONObject(body)
                    val requester = headers["x-discord-user-id"]
                    if (!canEdit(ownerId, requester)) {
                        jsonError(403, "editor is not allowed to update config")
                    } else {
                        val stored = configJson()
                        stored.put("config", payload.getJSONObject("config"))
                        stored.put("revision", stored.optLong("revision", 0L) + 1L)
                        saveConfig(stored)
                        httpResponse(204, "")
                    }
                }
                method == "GET" && path.startsWith("/allowed-editors") -> {
                    if (requesterId != ownerId) jsonError(403, "only owner can read allowed editors")
                    else {
                        val editors = configJson().optJSONArray("allowed_editors") ?: JSONArray()
                        httpResponse(200, JSONObject().put("allowed_editors", editors).toString())
                    }
                }
                method == "POST" && path == "/allowed-editors" -> {
                    val requester = headers["x-discord-user-id"]
                    if (requester != ownerId) jsonError(403, "only owner can modify allowed editors")
                    else {
                        val editorId = JSONObject(body).optString("editor_id")
                        val stored = configJson()
                        val editors = stored.optJSONArray("allowed_editors") ?: JSONArray()
                        if ((0 until editors.length()).none { editors.optString(it) == editorId }) {
                            editors.put(editorId)
                        }
                        stored.put("allowed_editors", editors)
                        saveConfig(stored)
                        httpResponse(204, "")
                    }
                }
                method == "DELETE" && path.startsWith("/allowed-editors/") -> {
                    val requester = headers["x-discord-user-id"]
                    if (requester != ownerId) jsonError(403, "only owner can modify allowed editors")
                    else {
                        val editorId = path.removePrefix("/allowed-editors/")
                        val stored = configJson()
                        val editors = stored.optJSONArray("allowed_editors") ?: JSONArray()
                        val updated = JSONArray()
                        for (i in 0 until editors.length()) {
                            val value = editors.optString(i)
                            if (value != editorId) updated.put(value)
                        }
                        stored.put("allowed_editors", updated)
                        saveConfig(stored)
                        httpResponse(204, "")
                    }
                }
                else -> jsonError(404, "not found")
            }

            it.getOutputStream().write(response.toByteArray())
            it.getOutputStream().flush()
        }
    }

    private fun canRead(ownerId: String, requesterId: String?): Boolean {
        if (requesterId == null) return false
        if (requesterId == ownerId) return true
        val editors = configJson().optJSONArray("allowed_editors") ?: JSONArray()
        return (0 until editors.length()).any { editors.optString(it) == requesterId }
    }

    private fun canEdit(ownerId: String, requesterId: String?): Boolean = canRead(ownerId, requesterId)

    private fun queryParam(path: String, key: String): String? {
        val idx = path.indexOf('?')
        if (idx < 0) return null
        return path.substring(idx + 1)
            .split('&')
            .mapNotNull {
                val pair = it.split('=', limit = 2)
                if (pair.size == 2 && pair[0] == key) pair[1] else null
            }
            .firstOrNull()
    }

    private fun configFile(): File = File(filesDir, "key-intercept-config.json")

    private fun configJson(): JSONObject {
        val file = configFile()
        if (!file.exists()) {
            val initial = JSONObject().apply {
                put("owner_discord_id", "")
                put("revision", 0)
                put("allowed_editors", JSONArray())
                put("config", JSONObject())
            }
            file.writeText(initial.toString())
            return initial
        }
        return runCatching { JSONObject(file.readText()) }.getOrElse {
            JSONObject().put("owner_discord_id", "").put("revision", 0).put("allowed_editors", JSONArray()).put("config", JSONObject())
        }
    }

    private fun saveConfig(config: JSONObject) {
        configFile().writeText(config.toString())
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(CHANNEL_ID, "Key Intercept Loopback", NotificationManager.IMPORTANCE_LOW)
            manager.createNotificationChannel(channel)
        }
    }

    private fun httpResponse(status: Int, body: String, contentType: String = "application/json"): String {
        val statusText = when (status) {
            200 -> "OK"
            202 -> "Accepted"
            204 -> "No Content"
            400 -> "Bad Request"
            403 -> "Forbidden"
            404 -> "Not Found"
            else -> "OK"
        }
        return "HTTP/1.1 $status $statusText\r\nContent-Type: $contentType\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body"
    }

    private fun jsonError(status: Int, message: String): String =
        httpResponse(status, JSONObject().put("error", message).toString())
}
