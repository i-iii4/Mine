import SwiftUI

struct ChannelListView: View {
    let channels: [Channel]
    let activeChannel: String?
    let vaultPath: String
    var onPickFolder: (() -> Void)?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(channels) { channel in
                    NavigationLink(value: channel.id) {
                        ChannelRow(
                            channel: channel,
                            isActive: isActive(channel),
                            vaultPath: vaultPath
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 16)
        }
        .safeAreaInset(edge: .bottom) {
            Button(action: { onPickFolder?() }) {
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                        .font(Arena.fontRegular())
                    Text("Change Vault")
                        .font(Arena.fontRegular())
                }
                .foregroundStyle(Arena.muted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(Arena.bg)
            }
            .overlay(alignment: .top) {
                Rectangle().fill(Arena.border).frame(height: 0.5)
            }
        }
    }

    private func isActive(_ channel: Channel) -> Bool {
        if channel.id == "__all__" { return activeChannel == nil }
        return activeChannel == channel.id
    }
}

// MARK: - Channel Row

struct ChannelRow: View {
    let channel: Channel
    let isActive: Bool
    let vaultPath: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Row 1: label + count + chevron
            HStack {
                Text(channel.label)
                    .font(Arena.fontRegular(Arena.textBase))
                    .foregroundStyle(isActive ? Arena.fg : Arena.muted)
                    .lineLimit(1)
                Text("\(channel.count)")
                    .font(Arena.fontRegular())
                    .foregroundStyle(Arena.tertiary)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(Arena.fontRegular())
                    .foregroundStyle(Arena.tertiary)
            }
            .padding(.horizontal, 12)

            // Row 2: horizontal scrolling thumbnails
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(channel.thumbSlugs, id: \.self) { slug in
                        thumbImage(slug)
                            .frame(width: 36, height: 36)
                            .clipped()
                    }
                }
                .padding(.leading, 12)
            }
        }
        .padding(.vertical, 10)
        .background(isActive ? Arena.sidebarAccent : .clear)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Arena.border)
                .frame(height: 0.5)
        }
    }

    @ViewBuilder
    private func thumbImage(_ slug: String) -> some View {
        let path = "\(vaultPath)/.arena/cache/thumbs/\(slug).jpg"
        if let img = UIImage(contentsOfFile: path) {
            Image(uiImage: img)
                .resizable()
                .scaledToFill()
        } else {
            Color(white: 0.15)
        }
    }
}
