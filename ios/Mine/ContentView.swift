import SwiftUI

struct ContentView: View {
    @EnvironmentObject var vaultModel: VaultViewModel
    @State private var selectedChannel: String?
    @State private var showFolderPicker = false

    var body: some View {
        NavigationStack {
            ZStack {
                Arena.bg.ignoresSafeArea()

                if vaultModel.isLoading {
                    ProgressView()
                        .tint(Arena.muted)
                } else if let error = vaultModel.error {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.title)
                            .foregroundStyle(Arena.muted)
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(Arena.muted)
                            .padding()
                    }
                } else if vaultModel.blocks.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "tray")
                            .font(.title)
                            .foregroundStyle(Arena.muted)
                        Text("No blocks yet")
                            .font(.subheadline)
                            .foregroundStyle(Arena.muted)
                    }
                } else {
                    ChannelListView(
                        channels: vaultModel.channels,
                        activeChannel: selectedChannel,
                        vaultPath: vaultModel.vaultPathString,
                        onPickFolder: { showFolderPicker = true }
                    )
                }
            }
            .navigationDestination(for: String.self) { channelId in
                let filteredBlocks = vaultModel.blocksForChannel(channelId == "__all__" ? nil : channelId)
                let label = vaultModel.channels.first { $0.id == channelId }?.label ?? "Everything"

                GridView(
                    blocks: filteredBlocks,
                    vaultPath: vaultModel.vaultPathString,
                    channelLabel: label
                )
            }
        }
        .tint(Arena.fg)
        .preferredColorScheme(.dark)
        .onAppear {
            setupAndOpenVault()
        }
        .sheet(isPresented: $showFolderPicker) {
            FolderPicker { url in
                vaultModel.switchVault(url: url)
                showFolderPicker = false
                selectedChannel = nil
            }
        }
    }

    private func setupAndOpenVault() {
        // 1. Try restoring saved bookmark (iCloud Drive folder)
        if let vaultURL = BookmarkManager.restore() {
            vaultModel.openVault(path: vaultURL.path)
            return
        }

        // 2. Fallback: local Documents/Vault with test data
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first!
        let vaultPath = docs.appendingPathComponent("Vault")

        let arenaDir = vaultPath.appendingPathComponent(".arena/cache/thumbs")
        try? fm.createDirectory(at: arenaDir, withIntermediateDirectories: true)

        let marker = vaultPath.appendingPathComponent(".arena/.seeded")
        if !fm.fileExists(atPath: marker.path) {
            if let bundleDir = Bundle.main.resourceURL {
                let files = (try? fm.contentsOfDirectory(at: bundleDir, includingPropertiesForKeys: nil)) ?? []
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
