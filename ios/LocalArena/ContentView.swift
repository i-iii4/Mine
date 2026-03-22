import SwiftUI

struct ContentView: View {
    @EnvironmentObject var vaultModel: VaultViewModel

    var body: some View {
        Group {
            if vaultModel.isLoading {
                ZStack {
                    Arena.bg.ignoresSafeArea()
                    ProgressView()
                        .tint(Arena.muted)
                }
            } else if let error = vaultModel.error {
                ZStack {
                    Arena.bg.ignoresSafeArea()
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.title)
                            .foregroundStyle(Arena.muted)
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(Arena.muted)
                            .padding()
                    }
                }
            } else if vaultModel.blocks.isEmpty {
                ZStack {
                    Arena.bg.ignoresSafeArea()
                    VStack(spacing: 12) {
                        Image(systemName: "tray")
                            .font(.title)
                            .foregroundStyle(Arena.muted)
                        Text("No blocks yet")
                            .font(.subheadline)
                            .foregroundStyle(Arena.muted)
                    }
                }
            } else {
                GridView(blocks: vaultModel.blocks, vaultPath: vaultModel.vaultPathString)
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            setupAndOpenVault()
        }
    }

    private func setupAndOpenVault() {
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first!
        let vaultPath = docs.appendingPathComponent("Vault")

        let arenaDir = vaultPath.appendingPathComponent(".arena/cache/thumbs")
        try? fm.createDirectory(at: arenaDir, withIntermediateDirectories: true)

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
