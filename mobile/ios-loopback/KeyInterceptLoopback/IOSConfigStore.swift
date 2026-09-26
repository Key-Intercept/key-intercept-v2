import Foundation

final class IOSConfigStore {
    private let queue = DispatchQueue(label: "keyintercept.loopback.config")
    private var store: [String: Any]

    init() {
        if let data = try? Data(contentsOf: Self.fileURL),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            store = object
        } else {
            store = [
                "owner_discord_id": "",
                "revision": 0,
                "allowed_editors": [String](),
                "config": [String: Any]()
            ]
            persist()
        }
    }

    static var fileURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("key-intercept", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("config.json")
    }

    var ownerId: String { queue.sync { (store["owner_discord_id"] as? String) ?? "" } }

    var allowedEditors: [String] {
        queue.sync { (store["allowed_editors"] as? [String]) ?? [] }
    }

    var configJSONString: String {
        queue.sync {
            let config = store["config"] ?? [:]
            guard let data = try? JSONSerialization.data(withJSONObject: config),
                  let value = String(data: data, encoding: .utf8) else { return "{}" }
            return value
        }
    }

    var allowedEditorsJSON: String {
        queue.sync {
            let payload: [String: Any] = ["allowed_editors": allowedEditors]
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let value = String(data: data, encoding: .utf8) else { return "{\"allowed_editors\":[]}" }
            return value
        }
    }

    func updateConfig(json: String) -> Bool {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["config"] != nil else { return false }
        queue.sync {
            store["config"] = object["config"]
            let rev = (store["revision"] as? Int ?? 0) + 1
            store["revision"] = rev
            persist()
        }
        return true
    }

    func addAllowedEditor(from json: String) -> Bool {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let editor = object["editor_id"] as? String,
              !editor.isEmpty else { return false }
        queue.sync {
            var editors = (store["allowed_editors"] as? [String]) ?? []
            if !editors.contains(editor) { editors.append(editor) }
            store["allowed_editors"] = editors
            persist()
        }
        return true
    }

    func removeAllowedEditor(_ editor: String) {
        queue.sync {
            var editors = (store["allowed_editors"] as? [String]) ?? []
            editors.removeAll { $0 == editor }
            store["allowed_editors"] = editors
            persist()
        }
    }

    private func persist() {
        if let data = try? JSONSerialization.data(withJSONObject: store, options: [.prettyPrinted]) {
            try? data.write(to: Self.fileURL)
        }
    }
}
