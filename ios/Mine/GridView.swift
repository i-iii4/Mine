import SwiftUI

struct GridView: View {
    let blocks: [FfiLightBlock]
    let vaultPath: String
    var channelLabel: String = "Everything"

    @State private var selectedBlock: FfiLightBlock?

    var body: some View {
        ScrollView {
            HStack(alignment: .top, spacing: Arena.gridGap) {
                ForEach(0..<2, id: \.self) { col in
                    LazyVStack(spacing: Arena.gridGap) {
                        ForEach(columnBlocks(col), id: \.slug) { block in
                            Button {
                                selectedBlock = block
                            } label: {
                                BlockCard(block: block, vaultPath: vaultPath)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, Arena.gridGap)
            .padding(.bottom, Arena.gridGap)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    Text(channelLabel)
                        .font(Arena.fontSemibold(Arena.textBase))
                        .foregroundStyle(Arena.fg)
                    Text("\(blocks.count)")
                        .font(Arena.fontRegular())
                        .foregroundStyle(Arena.muted)
                }
            }
        }
        .modifier(SoftScrollEdge())
        .sheet(item: $selectedBlock) { block in
            DetailView(block: block, vaultPath: vaultPath)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationBackground(Arena.bg)
        }
    }

    private func columnBlocks(_ col: Int) -> [FfiLightBlock] {
        blocks.enumerated()
            .filter { $0.offset % 2 == col }
            .map { $0.element }
    }
}

private struct SoftScrollEdge: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            content
        }
    }
}
