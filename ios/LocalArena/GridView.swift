import SwiftUI

struct GridView: View {
    let blocks: [FfiLightBlock]
    let vaultPath: String

    @State private var selectedSlug: String?

    var body: some View {
        if let slug = selectedSlug,
           let block = blocks.first(where: { $0.slug == slug }) {
            DetailView(block: block, vaultPath: vaultPath) {
                withAnimation(.easeInOut(duration: 0.2)) {
                    selectedSlug = nil
                }
            }
            .transition(.move(edge: .trailing))
        } else {
            ScrollView {
                HStack(alignment: .top, spacing: Arena.gridGap) {
                    ForEach(0..<2, id: \.self) { col in
                        LazyVStack(spacing: Arena.gridGap) {
                            ForEach(columnBlocks(col), id: \.slug) { block in
                                Button {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        selectedSlug = block.slug
                                    }
                                } label: {
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
            .transition(.move(edge: .leading))
        }
    }

    private func columnBlocks(_ col: Int) -> [FfiLightBlock] {
        blocks.enumerated()
            .filter { $0.offset % 2 == col }
            .map { $0.element }
    }
}
