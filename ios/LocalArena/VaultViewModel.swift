import Foundation
import Combine

extension FfiLightBlock: @retroactive Identifiable {}

struct Channel: Identifiable {
    let id: String          // tag (or "__all__")
    let label: String
    let count: Int
    let thumbSlugs: [String]
}

/// Bridge between SwiftUI and Rust core via UniFFI.
@MainActor
class VaultViewModel: ObservableObject {
    @Published var blocks: [FfiLightBlock] = []
    @Published var isLoading = false
    @Published var error: String?
    @Published var blockCount: UInt32 = 0
    @Published var vaultPathString: String = ""

    private var vault: ArenaVault?
    private var metadataQuery: NSMetadataQuery?
    private var queryObservers: [Any] = []

    var channels: [Channel] {
        // "Everything" first
        let allThumbs = blocks.map { $0.slug }
        var result = [Channel(id: "__all__", label: "Everything", count: blocks.count, thumbSlugs: Array(allThumbs))]

        // Group by tags
        var tagMap: [String: [FfiLightBlock]] = [:]
        for block in blocks {
            for tag in block.tags {
                tagMap[tag, default: []].append(block)
            }
        }

        // Sort by count DESC
        let sorted = tagMap.sorted { $0.value.count > $1.value.count }
        for (tag, tagBlocks) in sorted {
            let thumbs = tagBlocks.map { $0.slug }
            result.append(Channel(
                id: tag,
                label: titleFromTag(tag),
                count: tagBlocks.count,
                thumbSlugs: Array(thumbs)
            ))
        }
        return result
    }

    func blocksForChannel(_ channelId: String?) -> [FfiLightBlock] {
        guard let tag = channelId, tag != "__all__" else { return blocks }
        return blocks.filter { $0.tags.contains(tag) }
    }

    private func titleFromTag(_ tag: String) -> String {
        tag.split(separator: "-")
            .map { word in
                let s = String(word)
                return s.prefix(1).uppercased() + s.dropFirst()
            }
            .joined(separator: " ")
    }

    func switchVault(url: URL) {
        BookmarkManager.save(url)
        _ = url.startAccessingSecurityScopedResource()
        blocks = []
        openVault(path: url.path)
    }

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
                    self.vaultPathString = path
                    self.isLoading = false
                    self.startMonitoring()
                }
            } catch {
                await MainActor.run { [self] in
                    self.error = error.localizedDescription
                    self.isLoading = false
                }
            }
        }
    }

    // MARK: - iCloud Drive monitoring

    private func startMonitoring() {
        stopMonitoring()
        guard !vaultPathString.isEmpty else { return }

        let query = NSMetadataQuery()
        query.searchScopes = [vaultPathString]
        query.predicate = NSPredicate(format: "%K LIKE '*.md'", NSMetadataItemFSNameKey)

        let didUpdate = NotificationCenter.default.addObserver(
            forName: .NSMetadataQueryDidUpdate,
            object: query,
            queue: .main
        ) { [weak self] _ in
            self?.rescanVault()
        }

        let didFinish = NotificationCenter.default.addObserver(
            forName: .NSMetadataQueryDidFinishGathering,
            object: query,
            queue: .main
        ) { [weak self] _ in
            self?.rescanVault()
        }

        queryObservers = [didUpdate, didFinish]
        metadataQuery = query
        query.start()
    }

    private func stopMonitoring() {
        metadataQuery?.stop()
        metadataQuery = nil
        for observer in queryObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        queryObservers = []
    }

    private func rescanVault() {
        guard let vault else { return }

        Task.detached {
            let _ = try? vault.scanVault()
            let blocks = try? vault.listBlocks()
            await MainActor.run { [self] in
                if let blocks {
                    self.blocks = blocks
                }
            }
        }
    }
}
