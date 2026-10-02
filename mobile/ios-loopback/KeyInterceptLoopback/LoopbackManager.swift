import AVFoundation
import Foundation
import Network
import UserNotifications

final class LoopbackManager: ObservableObject {
    @Published var isRunning = false

    private var listener: NWListener?
    private var audioPlayer: AVAudioPlayer?
    private let queue = DispatchQueue(label: "keyintercept.loopback.listener")
    private let store = IOSConfigStore()

    func start() {
        guard !isRunning else { return }
        startSilentAudio()
        startLocalServer()
        requestNotificationPermission()
        showRunningNotification()
        DispatchQueue.main.async { self.isRunning = true }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        audioPlayer?.stop()
        audioPlayer = nil
        DispatchQueue.main.async { self.isRunning = false }
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

    private func startLocalServer() {
        do {
            let listener = try NWListener(using: .tcp, on: 35491)
            listener.newConnectionHandler = { [weak self] connection in
                self?.handle(connection: connection)
            }
            listener.stateUpdateHandler = { _ in }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            print("Failed to start loopback listener: \(error)")
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
}
