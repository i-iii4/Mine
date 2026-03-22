import SwiftUI

// MARK: - Card Router

struct BlockCard: View {
    let block: FfiLightBlock
    let vaultPath: String

    var body: some View {
        Group {
            switch block.blockType {
            case "image":
                ImageCard(block: block, vaultPath: vaultPath)
            case "article":
                if isSocialUrl(block.url) {
                    SocialCard(block: block, vaultPath: vaultPath)
                } else {
                    ArticleCard(block: block)
                }
            case "link":
                LinkCard(block: block, vaultPath: vaultPath)
            case "video":
                VideoCard(block: block, vaultPath: vaultPath)
            default:
                ArticleCard(block: block)
            }
        }
        .overlay(
            Rectangle()
                .stroke(Arena.border, lineWidth: 0.5)
        )
    }

    private func isSocialUrl(_ url: String?) -> Bool {
        guard let url = url?.lowercased() else { return false }
        return (url.contains("twitter.com/") || url.contains("x.com/")) && url.contains("/status/")
            || url.contains("instagram.com/p/")
            || url.contains("instagram.com/reel/")
            || url.contains("instagram.com/stories/")
    }
}

// MARK: - Image Card

struct ImageCard: View {
    let block: FfiLightBlock
    let vaultPath: String

    var body: some View {
        let src = block.mediaFile ?? "\(block.slug).jpg"
        let url = URL(fileURLWithPath: "\(vaultPath)/\(src)")

        let thumbUrl = URL(fileURLWithPath: "\(vaultPath)/.arena/cache/thumbs/\(block.slug).jpg")
        let image = UIImage(contentsOfFile: url.path) ?? UIImage(contentsOfFile: thumbUrl.path)

        if let image {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity)
        } else {
            Rectangle()
                .fill(Arena.bg)
                .aspectRatio(1, contentMode: .fit)
                .overlay(
                    Image(systemName: "photo")
                        .foregroundStyle(Arena.tertiary)
                )
        }
    }
}

// MARK: - Social Card (Twitter/Instagram)

struct SocialCard: View {
    let block: FfiLightBlock
    let vaultPath: String

    var body: some View {
        let cleanText = stripMarkdown(block.body)
        let mediaUrls = extractMediaUrls(block)

        VStack(alignment: .leading, spacing: 0) {
            if !cleanText.isEmpty {
                Text(cleanText)
                    .font(Arena.fontRegular())
                    .foregroundStyle(Arena.muted)
                    .lineLimit(3)
                    .lineSpacing(2)
            }

            if mediaUrls.count == 1 {
                // Single image: fill width, natural aspect ratio, max height
                Color.clear
                    .aspectRatio(4/3, contentMode: .fit)
                    .overlay(
                        mediaImage(mediaUrls[0])
                            .scaledToFill()
                    )
                    .clipped()
                    .padding(.top, Arena.textToMedia)
            } else if mediaUrls.count >= 2 {
                // Grid: 2 columns, square cells
                let gridColumns = [
                    GridItem(.flexible(), spacing: Arena.mediaGap),
                    GridItem(.flexible(), spacing: Arena.mediaGap)
                ]
                LazyVGrid(columns: gridColumns, spacing: Arena.mediaGap) {
                    ForEach(Array(mediaUrls.prefix(4).enumerated()), id: \.offset) { _, url in
                        Color.clear
                            .aspectRatio(1, contentMode: .fit)
                            .overlay(
                                mediaImage(url)
                                    .scaledToFill()
                            )
                            .clipped()
                    }
                }
                .padding(.top, Arena.textToMedia)
            }

            if let author = block.author, !author.isEmpty {
                Text("by \(author)")
                    .font(Arena.fontRegular())
                    .foregroundStyle(Arena.muted)
                    .padding(.top, Arena.textToAuthor)
            }
        }
        .padding(Arena.cardPadding)
    }

    @ViewBuilder
    private func mediaImage(_ filename: String) -> some View {
        let path = "\(vaultPath)/\(filename)"
        if let img = UIImage(contentsOfFile: path) {
            Image(uiImage: img)
                .resizable()
        } else {
            Rectangle().fill(Arena.border)
        }
    }

    private func extractMediaUrls(_ block: FfiLightBlock) -> [String] {
        // Parse ![](filename) from body
        var urls: [String] = []
        let pattern = #"!\[.*?\]\((.+?)\)"#
        if let regex = try? NSRegularExpression(pattern: pattern) {
            let range = NSRange(block.body.startIndex..., in: block.body)
            let matches = regex.matches(in: block.body, range: range)
            for match in matches {
                if let urlRange = Range(match.range(at: 1), in: block.body) {
                    urls.append(String(block.body[urlRange]))
                }
            }
        }
        // Fallback: media_urls from index
        if urls.isEmpty, let mediaJson = block.mediaUrls,
           let data = mediaJson.data(using: .utf8),
           let parsed = try? JSONDecoder().decode([String].self, from: data) {
            urls = parsed
        }
        return urls
    }
}

// MARK: - Article Card

struct ArticleCard: View {
    let block: FfiLightBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title = block.title, !title.isEmpty {
                Text(title)
                    .font(Arena.fontSemibold())
                    .foregroundStyle(Arena.fg)
                    .lineLimit(2)
            }

            let preview = stripMarkdown(block.body)
            if !preview.isEmpty {
                Text(preview)
                    .font(Arena.fontRegular())
                    .foregroundStyle(Arena.muted)
                    .lineLimit(8)
                    .lineSpacing(2)
                    .padding(.top, Arena.titleToBody)
            }

            if let author = block.author, !author.isEmpty {
                Text(author)
                    .font(Arena.fontRegular())
                    .foregroundStyle(Arena.muted)
                    .padding(.top, Arena.textToAuthor)
            }
        }
        .padding(Arena.cardPadding)
    }
}

// MARK: - Link Card

struct LinkCard: View {
    let block: FfiLightBlock
    let vaultPath: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Thumbnail
            let thumbPath = "\(vaultPath)/.arena/cache/thumbs/\(block.slug).jpg"
            if let img = UIImage(contentsOfFile: thumbPath) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity)
                    .aspectRatio(16/9, contentMode: .fill)
                    .clipped()
            }

            VStack(alignment: .leading, spacing: 2) {
                if let title = block.title, !title.isEmpty {
                    Text(title)
                        .font(Arena.fontSemibold())
                        .foregroundStyle(Arena.fg)
                        .lineLimit(1)
                }
                if let url = block.url {
                    Text(domainFromUrl(url))
                        .font(Arena.fontRegular(11))
                        .foregroundStyle(Arena.tertiary)
                        .lineLimit(1)
                }
            }
            .padding(12)
        }
    }

    private func domainFromUrl(_ url: String) -> String {
        guard let parsed = URL(string: url) else { return url }
        return parsed.host?.replacingOccurrences(of: "www.", with: "") ?? url
    }
}

// MARK: - Video Card

struct VideoCard: View {
    let block: FfiLightBlock
    let vaultPath: String

    var body: some View {
        ZStack {
            let thumbPath = "\(vaultPath)/.arena/cache/thumbs/\(block.slug).jpg"
            if let img = UIImage(contentsOfFile: thumbPath) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity)
                    .aspectRatio(16/9, contentMode: .fill)
                    .clipped()
            } else {
                Rectangle()
                    .fill(Arena.bg)
                    .aspectRatio(16/9, contentMode: .fit)
            }

            // Play icon
            Image(systemName: "play.fill")
                .font(.system(size: 20))
                .foregroundStyle(.white)
                .padding(12)
                .background(Circle().fill(.black.opacity(0.5)))

            // Title overlay at bottom
            if let title = block.title, !title.isEmpty {
                VStack {
                    Spacer()
                    HStack {
                        Text(title)
                            .font(Arena.fontRegular())
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        Spacer()
                    }
                    .padding(12)
                    .background(
                        LinearGradient(colors: [.clear, .black.opacity(0.6)], startPoint: .top, endPoint: .bottom)
                    )
                }
            }
        }
    }
}

// MARK: - Helpers

func stripMarkdown(_ text: String) -> String {
    text.replacingOccurrences(of: #"!\[.*?\]\(.*?\)"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"\[(.+?)\]\(.*?\)"#, with: "$1", options: .regularExpression)
        .replacingOccurrences(of: #"(?m)^#{1,6}\s+"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"\*\*(.+?)\*\*"#, with: "$1", options: .regularExpression)
        .replacingOccurrences(of: #"(?m)^---+$"#, with: "", options: .regularExpression)
        .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}
