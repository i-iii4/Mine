import SwiftUI

struct GridView: View {
    let blocks: [FfiLightBlock]
    let vaultPath: String
    var channelLabel: String = "Everything"
    var onShowChannels: (() -> Void)?

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
            VStack(spacing: 0) {
                // Channel header
                HStack {
                    Button {
                        onShowChannels?()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "line.3.horizontal")
                                .font(.system(size: 14))
                            Text(channelLabel)
                                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                        }
                        .foregroundStyle(Arena.fg)
                    }
                    .buttonStyle(.plain)

                    Spacer()

                    Text("\(blocks.count)")
                        .font(Arena.fontRegular())
                        .foregroundStyle(Arena.muted)
                }
                .padding(.horizontal, Arena.gridGap + 4)
                .padding(.vertical, 10)

                // Grid
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
                    .padding(.bottom, Arena.gridGap)
                }
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
