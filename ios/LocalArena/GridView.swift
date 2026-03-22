import SwiftUI

struct GridView: View {
    let blocks: [FfiLightBlock]

    let columns = [
        GridItem(.adaptive(minimum: 160), spacing: 8)
    ]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(blocks, id: \.slug) { block in
                    CardView(block: block)
                }
            }
            .padding(.horizontal)
        }
    }
}

struct CardView: View {
    let block: FfiLightBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Type badge
            HStack {
                Text(block.blockType.uppercased())
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
            }

            // Title
            if let title = block.title {
                Text(title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .lineLimit(2)
            }

            // Body preview
            if !block.body.isEmpty {
                Text(block.body)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }

            // Author
            if let author = block.author {
                Text(author)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemGray6))
    }
}
