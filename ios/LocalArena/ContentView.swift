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
                            .padding()
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
            setupAndOpenVault()
        }
    }

    private func setupAndOpenVault() {
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first!
        let vaultPath = docs.appendingPathComponent("Vault")

        // Create vault + .arena dirs
        let arenaDir = vaultPath.appendingPathComponent(".arena/cache/thumbs")
        try? fm.createDirectory(at: arenaDir, withIntermediateDirectories: true)

        // Copy test .md files from bundle on first launch
        let marker = vaultPath.appendingPathComponent(".arena/.seeded")
        if !fm.fileExists(atPath: marker.path) {
            if let testDir = Bundle.main.resourceURL?.appendingPathComponent("TestData") {
                let files = (try? fm.contentsOfDirectory(at: testDir, includingPropertiesForKeys: nil)) ?? []
                for file in files where file.pathExtension == "md" {
                    let dest = vaultPath.appendingPathComponent(file.lastPathComponent)
                    try? fm.copyItem(at: file, to: dest)
                }
            }
            fm.createFile(atPath: marker.path, contents: nil)
        }

        vaultModel.openVault(path: vaultPath.path)
    }
}
