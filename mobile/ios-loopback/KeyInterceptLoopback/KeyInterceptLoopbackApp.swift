import SwiftUI

@main
struct KeyInterceptLoopbackApp: App {
    @StateObject private var manager = LoopbackManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(manager)
        }
    }
}
