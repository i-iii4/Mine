import SwiftUI

struct GridView: View {
    let blocks: [FfiLightBlock]
    let vaultPath: String

    var body: some View {
        NavigationStack {
            ScrollView {
                HStack(alignment: .top, spacing: Arena.gridGap) {
                    ForEach(0..<2, id: \.self) { col in
                        LazyVStack(spacing: Arena.gridGap) {
                            ForEach(columnBlocks(col), id: \.slug) { block in
                                NavigationLink(value: block.slug) {
                                    BlockCard(block: block, vaultPath: vaultPath)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(.horizontal, Arena.gridGap)
                .padding(.vertical, Arena.gridGap)
            }
            .background(Arena.bg.ignoresSafeArea())
            .navigationBarHidden(true)
            .navigationDestination(for: String.self) { slug in
                if let block = blocks.first(where: { $0.slug == slug }) {
                    DetailView(block: block, vaultPath: vaultPath)
                }
            }
        }
    }

    private func columnBlocks(_ col: Int) -> [FfiLightBlock] {
        blocks.enumerated()
            .filter { $0.offset % 2 == col }
            .map { $0.element }
    }
}
