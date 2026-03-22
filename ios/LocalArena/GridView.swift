import SwiftUI

struct GridView: View {
    let blocks: [FfiLightBlock]
    let vaultPath: String

    var body: some View {
        ScrollView {
            HStack(alignment: .top, spacing: Arena.gridGap) {
                // Masonry: round-robin into 2 columns (same as desktop)
                ForEach(0..<2, id: \.self) { col in
                    LazyVStack(spacing: Arena.gridGap) {
                        ForEach(columnBlocks(col), id: \.slug) { block in
                            BlockCard(block: block, vaultPath: vaultPath)
                        }
                    }
                }
            }
            .padding(.horizontal, Arena.gridGap)
            .padding(.top, Arena.gridGap)
        }
        .background(Arena.bg)
    }

    private func columnBlocks(_ col: Int) -> [FfiLightBlock] {
        blocks.enumerated()
            .filter { $0.offset % 2 == col }
            .map { $0.element }
    }
}
