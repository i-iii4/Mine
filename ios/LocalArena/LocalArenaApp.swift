import SwiftUI

@main
struct LocalArenaApp: App {
    @StateObject private var vaultModel = VaultViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(vaultModel)
        }
    }
}
