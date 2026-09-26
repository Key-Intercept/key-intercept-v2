import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var manager: LoopbackManager

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(manager.isRunning ? "Key Intercept Loopback is running in the background" : "Key Intercept Loopback is currently stopped")
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

            Spacer()
        }
        .padding()
    }
}
