import SwiftUI

struct ContentView: View {
    @EnvironmentObject var vaultModel: VaultViewModel

    var body: some View {
        NavigationStack {
            Group {
                if vaultModel.isLoading {
                    ProgressView("Loading vault...")
                } else if let error = vaultModel.error {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else if vaultModel.blocks.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "tray")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text("No blocks yet")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    GridView(blocks: vaultModel.blocks)
                }
            }
            .navigationTitle("Local Arena")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            // TODO: Replace with iCloud vault path
            let documentsPath = FileManager.default
                .urls(for: .documentDirectory, in: .userDomainMask)
                .first?.path ?? ""
            vaultModel.openVault(path: documentsPath)
        }
    }
}
