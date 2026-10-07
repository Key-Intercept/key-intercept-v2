import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var manager: LoopbackManager

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(manager.statusMessage)
                .font(.headline)

            Button("Start Loopback") {
                manager.start()
            }

            Button("Stop Loopback") {
                manager.stop()
            }

            Text("Silent audio keepalive is \(manager.isRunning ? "enabled" : "disabled").")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if manager.logs.isEmpty {
                Text("Logs will appear here")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(manager.logs.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()
        }
        .padding()
    }
}
