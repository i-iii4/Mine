import Foundation

/// Bridge between SwiftUI and Rust core via UniFFI.
@MainActor
class VaultViewModel: ObservableObject {
    @Published var blocks: [FfiLightBlock] = []
    @Published var isLoading = false
    @Published var error: String?
    @Published var blockCount: UInt32 = 0

    private var vault: ArenaVault?

    func openVault(path: String) {
        isLoading = true
        error = nil

        Task.detached {
            do {
                let vault = try ArenaVault.open(vaultPath: path)
                let indexed = try vault.scanVault()
                let blocks = try vault.listBlocks()
                await MainActor.run { [self] in
                    self.vault = vault
                    self.blocks = blocks
                    self.blockCount = indexed
                    self.isLoading = false
                }
            } catch {
                await MainActor.run { [self] in
                    self.error = error.localizedDescription
                    self.isLoading = false
                }
            }
        }
    }
}
