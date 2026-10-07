import AVFoundation
import Foundation
import Network
import UserNotifications

final class LoopbackManager: ObservableObject {
    @Published var isRunning = false
    @Published var statusMessage = "Key Intercept Loopback is currently stopped"
    @Published var logs: [String] = []

    private var listener: NWListener?
    private var audioPlayer: AVAudioPlayer?
    private let queue = DispatchQueue(label: "keyintercept.loopback.listener")
    private let store = IOSConfigStore()
    private static let maxLogLines = 12
    private static let statusPrefsKey = "key_intercept_loopback_status_message"
    private static let logsPrefsKey = "key_intercept_loopback_logs"
    private static let defaultLoopbackPort: UInt16 = 35491
    private let loopbackPort: UInt16

    init() {
        let configuredPort = Bundle.main.object(forInfoDictionaryKey: "KEY_INTERCEPT_LOOPBACK_PORT") as? String
        let parsedPort = UInt16(configuredPort ?? "")
        loopbackPort = parsedPort ?? Self.defaultLoopbackPort
        restorePersistedStatus()
    }

    func start() {
        guard !isRunning else { return }
        appendLog("requested start")
        updateStatus("Key Intercept Loopback is starting in the background")
        startSilentAudio()
        let serverStarted = startLocalServer()
        guard serverStarted else {
            audioPlayer?.stop()
            audioPlayer = nil
            updateStatus("Key Intercept Loopback failed to start")
            return
        }
        requestNotificationPermission()
        showRunningNotification()
        DispatchQueue.main.async {
            self.isRunning = true
            self.updateStatus("Key Intercept Loopback is running in the background")
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        audioPlayer?.stop()
        audioPlayer = nil
        DispatchQueue.main.async {
            self.isRunning = false
            self.updateStatus("Key Intercept Loopback is currently stopped")
            self.appendLog("requested stop")
        }
    }

    private func startSilentAudio() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)

        guard let url = Bundle.main.url(forResource: "silence", withExtension: "wav") else { return }
        audioPlayer = try? AVAudioPlayer(contentsOf: url)
        audioPlayer?.numberOfLoops = -1
        audioPlayer?.volume = 0.0
        audioPlayer?.play()
    }

    private func startLocalServer() -> Bool {
        do {
            guard let nwPort = NWEndpoint.Port(rawValue: loopbackPort) else {
                DispatchQueue.main.async {
                    self.isRunning = false
                    self.updateStatus("Key Intercept Loopback failed to start: invalid port")
                    self.appendLog("listener start failed: invalid port \(self.loopbackPort)")
                }
                return false
            }
            let listener = try NWListener(using: .tcp, on: nwPort)
            listener.newConnectionHandler = { [weak self] connection in
                self?.handle(connection: connection)
            }
            listener.stateUpdateHandler = { [weak self] (state: NWListener.State) in
                guard let self else { return }
                switch state {
                case .failed(let error):
                    DispatchQueue.main.async {
                        self.isRunning = false
                        self.updateStatus("Key Intercept Loopback failed to start: \(error.localizedDescription)")
                        self.appendLog("listener failed: \(error.localizedDescription)")
                    }
                case .ready:
                    DispatchQueue.main.async {
                        self.appendLog("listening on 127.0.0.1:\(self.loopbackPort)")
                    }
                default:
                    break
                }
            }
            listener.start(queue: queue)
            self.listener = listener
            return true
        } catch {
            DispatchQueue.main.async {
                self.isRunning = false
                self.updateStatus("Key Intercept Loopback failed to start: \(error.localizedDescription)")
                self.appendLog("listener start failed: \(error.localizedDescription)")
            }
            return false
        }
    }

    private func handle(connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, _, _ in
            guard let self, let data, let request = String(data: data, encoding: .utf8) else {
                connection.cancel(); return
            }
            let response = self.route(request)
            connection.send(content: response.data(using: .utf8), completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }

    private func route(_ request: String) -> String {
        let lines = request.components(separatedBy: "\r\n")
        guard let first = lines.first else { return response(status: 400, body: "{\"error\":\"bad request\"}") }
        let parts = first.split(separator: " ")
        guard parts.count >= 2 else { return response(status: 400, body: "{\"error\":\"bad request\"}") }

        let method = String(parts[0])
        let path = String(parts[1])
        let headers = parseHeaders(lines)
        let body = request.components(separatedBy: "\r\n\r\n").dropFirst().joined(separator: "\r\n\r\n")

        switch (method, path) {
        case ("GET", let p) where p.hasPrefix("/health"):
            return response(status: 200, body: "ok", contentType: "text/plain")
        case ("GET", let p) where p.hasPrefix("/config"):
            guard canRead(path: p, headers: headers) else { return response(status: 403, body: "{\"error\":\"requester is not allowed to read config\"}") }
            return response(status: 200, body: store.configJSONString)
        case ("PUT", "/config"):
            guard canEdit(headers: headers) else { return response(status: 403, body: "{\"error\":\"editor is not allowed to update config\"}") }
            if store.updateConfig(json: body) {
                return response(status: 204, body: "")
            }
            return response(status: 400, body: "{\"error\":\"invalid config payload\"}")
        case ("GET", "/allowed-editors"):
            guard headers["x-discord-user-id"] == store.ownerId else { return response(status: 403, body: "{\"error\":\"only owner can read allowed editors\"}") }
            return response(status: 200, body: store.allowedEditorsJSON)
        case ("POST", "/allowed-editors"):
            guard headers["x-discord-user-id"] == store.ownerId else { return response(status: 403, body: "{\"error\":\"only owner can modify allowed editors\"}") }
            if store.addAllowedEditor(from: body) { return response(status: 204, body: "") }
            return response(status: 400, body: "{\"error\":\"invalid editor payload\"}")
        case ("DELETE", let p) where p.hasPrefix("/allowed-editors/"):
            guard headers["x-discord-user-id"] == store.ownerId else { return response(status: 403, body: "{\"error\":\"only owner can modify allowed editors\"}") }
            let editorId = p.replacingOccurrences(of: "/allowed-editors/", with: "")
            store.removeAllowedEditor(editorId)
            return response(status: 204, body: "")
        default:
            return response(status: 404, body: "{\"error\":\"not found\"}")
        }
    }

    private func canRead(path: String, headers: [String: String]) -> Bool {
        let requester = headers["x-discord-user-id"] ?? queryValue(path: path, key: "requester_id")
        guard let requester else { return false }
        if requester == store.ownerId { return true }
        return store.allowedEditors.contains(requester)
    }

    private func canEdit(headers: [String: String]) -> Bool {
        guard let requester = headers["x-discord-user-id"] else { return false }
        return requester == store.ownerId || store.allowedEditors.contains(requester)
    }

    private func parseHeaders(_ lines: [String]) -> [String: String] {
        var headers: [String: String] = [:]
        for line in lines where line.contains(":") {
            let parts = line.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2 {
                headers[parts[0].trimmingCharacters(in: .whitespaces).lowercased()] = parts[1].trimmingCharacters(in: .whitespaces)
            }
        }
        return headers
    }

    private func queryValue(path: String, key: String) -> String? {
        guard let idx = path.firstIndex(of: "?") else { return nil }
        let query = path[path.index(after: idx)...]
        for pair in query.split(separator: "&") {
            let bits = pair.split(separator: "=", maxSplits: 1)
            if bits.count == 2 && bits[0] == key { return String(bits[1]) }
        }
        return nil
    }

    private func response(status: Int, body: String, contentType: String = "application/json") -> String {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 202: statusText = "Accepted"
        case 204: statusText = "No Content"
        case 400: statusText = "Bad Request"
        case 403: statusText = "Forbidden"
        case 404: statusText = "Not Found"
        default: statusText = "OK"
        }
        return "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
    }

    private func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func showRunningNotification() {
        let content = UNMutableNotificationContent()
        content.title = "Key Intercept Loopback"
        content.body = "Key Intercept Loopback is running in the background"
        let request = UNNotificationRequest(identifier: "loopback-running", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    private func updateStatus(_ message: String) {
        statusMessage = message
        UserDefaults.standard.set(message, forKey: Self.statusPrefsKey)
    }

    private func appendLog(_ line: String) {
        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        var nextLogs = logs
        nextLogs.append(text)
        if nextLogs.count > Self.maxLogLines {
            nextLogs = Array(nextLogs.suffix(Self.maxLogLines))
        }
        logs = nextLogs
        UserDefaults.standard.set(nextLogs.joined(separator: "\n"), forKey: Self.logsPrefsKey)
    }

    private func restorePersistedStatus() {
        let defaults = UserDefaults.standard
        if let persistedStatus = defaults.string(forKey: Self.statusPrefsKey), !persistedStatus.isEmpty {
            statusMessage = persistedStatus
        }
        if let persistedLogs = defaults.string(forKey: Self.logsPrefsKey), !persistedLogs.isEmpty {
            logs = Array(persistedLogs
                .split(separator: "\n")
                .map(String.init)
                .suffix(Self.maxLogLines))
        }
    }
}
