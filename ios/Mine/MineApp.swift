import SwiftUI

@main
struct MineApp: App {
    @StateObject private var vaultModel = VaultViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(vaultModel)
        }
    }
}
