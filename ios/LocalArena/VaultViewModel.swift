import Foundation

/// Bridge between SwiftUI and Rust core via UniFFI.
@MainActor
class VaultViewModel: ObservableObject {
    @Published var blocks: [FfiLightBlock] = []
    @Published var isLoading = false
    @Published var error: String?

    private var vault: ArenaVault?

    func openVault(path: String) {
        isLoading = true
        error = nil

        Task.detached { [weak self] in
            do {
                let vault = try ArenaVault.open(vaultPath: path)
                let blocks = try vault.listBlocks()
                await MainActor.run {
                    self?.vault = vault
                    self?.blocks = blocks
                    self?.isLoading = false
                }
            } catch {
                await MainActor.run {
                    self?.error = error.localizedDescription
                    self?.isLoading = false
                }
            }
        }
    }
}
