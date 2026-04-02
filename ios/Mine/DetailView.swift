import SwiftUI
import AVKit

struct DetailView: View {
    let block: FfiLightBlock
    let vaultPath: String

    @Environment(\.dismiss) private var dismiss
    @State private var fullBody: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Close button (X)
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(Arena.fontSemibold(Arena.textBase))
                            .foregroundStyle(Arena.muted)
                            .frame(width: 30, height: 30)
                            .background(Circle().fill(Color.white.opacity(0.1)))
                    }
                }
                .padding(.horizontal, Arena.cardPadding)
                .padding(.top, 8)

                // Image blocks: full image at top
                if block.blockType == "image" {
                    imageContent()
                }

                // Video blocks: thumbnail with play
                if block.blockType == "video" {
                    videoContent()
                }

                // Link blocks: thumbnail
                if block.blockType == "link" {
                    linkThumbnail()
                }

                // Text content area
                VStack(alignment: .leading, spacing: 0) {
                    // Title (not for social posts)
                    if !isSocialUrl(block.url), let title = block.title, !title.isEmpty {
                        Text(title)
                            .font(Arena.fontSemibold(Arena.textLg))
                            .foregroundStyle(Arena.fg)
                    }

                    // Author
                    if let author = block.author, !author.isEmpty {
                        Text(author)
                            .font(Arena.fontRegular())
                            .foregroundStyle(Arena.muted)
                            .padding(.top, 4)
                    }

                    // Body (full, not truncated)
                    if !fullBody.isEmpty {
                        Text(fullBody)
                            .font(Arena.fontRegular(Arena.textBase))
                            .foregroundStyle(Arena.fg)
                            .lineSpacing(4)
                            .padding(.top, 12)
                    }

                    // Inline media from body
                    let mediaUrls = extractBodyMedia(fullBody)
                    if !mediaUrls.isEmpty {
                        VStack(spacing: Arena.mediaGap) {
                            ForEach(Array(mediaUrls.enumerated()), id: \.offset) { _, filename in
                                let path = "\(vaultPath)/\(filename)"
                                let isVideo = filename.hasSuffix(".mp4") || filename.hasSuffix(".mov") || filename.hasSuffix(".webm")

                                if isVideo {
                                    AutoplayVideo(url: URL(fileURLWithPath: path))
                                        .aspectRatio(16/9, contentMode: .fit)
                                        .frame(maxWidth: .infinity)
                                } else if let img = UIImage(contentsOfFile: path) {
                                    Image(uiImage: img)
                                        .resizable()
                                        .scaledToFit()
                                        .frame(maxWidth: .infinity)
                                }
                            }
                        }
                        .padding(.top, 12)
                    }
                }
                .padding(Arena.cardPadding)

                // Metadata
                metadataSection()
            }
        }
        .background(Arena.bg)
        .onAppear {
            loadFullBody()
        }
    }

    // MARK: - Content sections

    @ViewBuilder
    private func imageContent() -> some View {
        let src = block.mediaFile ?? "\(block.slug).jpg"
        let path = "\(vaultPath)/\(src)"
        if let img = UIImage(contentsOfFile: path) {
            Image(uiImage: img)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private func videoContent() -> some View {
        let thumbPath = "\(vaultPath)/.arena/cache/thumbs/\(block.slug).jpg"
        ZStack {
            if let img = UIImage(contentsOfFile: thumbPath) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
            }
            Image(systemName: "play.fill")
                .font(.system(size: 32))
                .foregroundStyle(.white)
                .padding(16)
                .background(Circle().fill(.black.opacity(0.5)))
        }
    }

    @ViewBuilder
    private func linkThumbnail() -> some View {
        let thumbPath = "\(vaultPath)/.arena/cache/thumbs/\(block.slug).jpg"
        if let img = UIImage(contentsOfFile: thumbPath) {
            Image(uiImage: img)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private func metadataSection() -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider().background(Arena.border)

            metaRow("TYPE", block.blockType.uppercased())

            if let url = block.url, !url.isEmpty {
                metaRow("SOURCE", domainFromUrl(url))
            }

            metaRow("DATE", formatDate(block.savedAt))

            if let author = block.author, !author.isEmpty {
                metaRow("AUTHOR", author)
            }

            if !block.tags.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("TAGS")
                        .font(Arena.fontSemibold())
                        .foregroundStyle(Arena.tertiary)
                        .tracking(1)
                    HStack(spacing: 4) {
                        ForEach(block.tags, id: \.self) { tag in
                            Text(tag)
                                .font(Arena.fontRegular())
                                .foregroundStyle(Arena.muted)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 2)
                                        .stroke(Arena.border, lineWidth: 0.5)
                                )
                        }
                    }
                }
            }
        }
        .padding(Arena.cardPadding)
    }

    @ViewBuilder
    private func metaRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(Arena.fontSemibold())
                .foregroundStyle(Arena.tertiary)
                .tracking(1)
            Text(value)
                .font(Arena.fontRegular())
                .foregroundStyle(Arena.fg)
        }
    }

    // MARK: - Helpers

    private func loadFullBody() {
        let path = "\(vaultPath)/\(block.slug).md"
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return }

        // Split at closing --- to get body
        let lines = content.components(separatedBy: "\n")
        var foundOpen = false
        var foundClose = false
        var bodyLines: [String] = []

        for line in lines {
            if !foundOpen && line == "---" {
                foundOpen = true
                continue
            }
            if foundOpen && !foundClose && line == "---" {
                foundClose = true
                continue
            }
            if foundClose {
                bodyLines.append(line)
            }
        }

        let body = bodyLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        // Strip markdown images (they're shown separately)
        fullBody = body.replacingOccurrences(
            of: #"!\[.*?\]\(.*?\)"#,
            with: "",
            options: .regularExpression
        ).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func extractBodyMedia(_ body: String) -> [String] {
        // Read from original file to get image refs
        let path = "\(vaultPath)/\(block.slug).md"
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }

        var urls: [String] = []
        let pattern = #"!\[.*?\]\((.+?)\)"#
        if let regex = try? NSRegularExpression(pattern: pattern) {
            let range = NSRange(content.startIndex..., in: content)
            for match in regex.matches(in: content, range: range) {
                if let urlRange = Range(match.range(at: 1), in: content) {
                    let filename = String(content[urlRange])
                    if !filename.hasPrefix("http") {
                        urls.append(filename)
                    }
                }
            }
        }
        return urls
    }

    @ViewBuilder
    private func localImage(_ filename: String) -> some View {
        let path = "\(vaultPath)/\(filename)"
        if let img = UIImage(contentsOfFile: path) {
            Image(uiImage: img)
                .resizable()
        } else {
            Image(systemName: "photo")
                .foregroundStyle(Arena.tertiary)
        }
    }

    private func isSocialUrl(_ url: String?) -> Bool {
        guard let url = url?.lowercased() else { return false }
        return (url.contains("twitter.com/") || url.contains("x.com/")) && url.contains("/status/")
            || url.contains("instagram.com/p/")
            || url.contains("instagram.com/reel/")
    }

    private func domainFromUrl(_ url: String) -> String {
        guard let parsed = URL(string: url) else { return url }
        return parsed.host?.replacingOccurrences(of: "www.", with: "") ?? url
    }

    private func formatDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        let display = DateFormatter()
        display.dateStyle = .medium
        display.locale = Locale(identifier: "ru_RU")
        return display.string(from: date)
    }
}

// MARK: - Autoplay Video

struct AutoplayVideo: View {
    let url: URL
    @State private var player: AVPlayer?

    var body: some View {
        VideoPlayer(player: player)
            .onAppear {
                let p = AVPlayer(url: url)
                p.isMuted = true
                player = p
                p.play()

                // Loop
                NotificationCenter.default.addObserver(
                    forName: .AVPlayerItemDidPlayToEndTime,
                    object: p.currentItem,
                    queue: .main
                ) { _ in
                    p.seek(to: .zero)
                    p.play()
                }
            }
            .onDisappear {
                player?.pause()
                player = nil
            }
    }
}
