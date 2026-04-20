import SwiftUI
import AVKit
import AVFoundation
import CryptoKit

struct DetailView: View {
    let block: FfiLightBlock
    let vaultPath: String

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var vaultModel: VaultViewModel
    @State private var fullBody: String = ""
    @StateObject private var audioController: ArticleAudioController

    init(block: FfiLightBlock, vaultPath: String) {
        self.block = block
        self.vaultPath = vaultPath
        _audioController = StateObject(
            wrappedValue: ArticleAudioController(block: block, vaultPath: vaultPath)
        )
    }

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

                    if audioController.isSupported {
                        audioSection()
                            .padding(.top, 12)
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
        .task(id: block.slug) {
            await audioController.load(using: vaultModel)
        }
        .onDisappear {
            audioController.handleDisappear()
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
    private func audioSection() -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "speaker.wave.2")
                    .font(Arena.fontSemibold())
                    .foregroundStyle(Arena.muted)
                Text("AUDIO")
                    .font(Arena.fontSemibold())
                    .foregroundStyle(Arena.muted)
                    .tracking(1)
            }

            if audioController.isReady {
                audioButton(
                    title: audioController.isRemoving ? "Removing Audio…" : "Remove Audio",
                    systemImage: "trash",
                    disabled: audioController.isRemoving,
                    action: {
                        audioController.removeAudio()
                    }
                )

                audioButton(
                    title: audioController.isPlaying ? "Pause" : "Play",
                    systemImage: audioController.isPlaying ? "pause.fill" : "play.fill",
                    action: {
                        audioController.togglePlayback()
                    }
                )

                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(formatAudioTime(audioController.currentTimeMs))
                        Spacer()
                        Text(formatAudioTime(audioController.durationMs))
                    }
                    .font(Arena.fontSemibold())
                    .foregroundStyle(Arena.muted)

                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 999)
                                .fill(Arena.border)
                            RoundedRectangle(cornerRadius: 999)
                                .fill(Arena.fg)
                                .frame(width: geometry.size.width * audioController.progressFraction)
                        }
                    }
                    .frame(height: 4)
                }
            } else {
                audioButton(
                    title: audioController.primaryActionTitle,
                    systemImage: audioController.isLoading || audioController.isGenerating ? "ellipsis" : "speaker.wave.2",
                    disabled: audioController.isLoading || audioController.isGenerating,
                    action: {
                        Task { await audioController.generateAudio() }
                    }
                )
            }

            if let error = audioController.errorMessage {
                Text(error)
                    .font(Arena.fontRegular())
                    .foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder
    private func audioButton(
        title: String,
        systemImage: String,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(Arena.fontSemibold())
                Text(title)
                    .font(Arena.fontSemibold())
                Spacer()
            }
            .foregroundStyle(disabled ? Arena.tertiary : Arena.fg)
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Arena.border, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
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

    private func formatAudioTime(_ ms: Int?) -> String {
        guard let ms, ms >= 0 else { return "--:--" }
        let totalSeconds = ms / 1000
        let minutes = totalSeconds / 60
        let seconds = totalSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
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

private enum ArticleAudioSupport {
    static func supports(block: FfiLightBlock) -> Bool {
        guard block.blockType == "article" else { return false }
        guard let url = block.url?.lowercased() else { return true }
        if (url.contains("twitter.com/") || url.contains("x.com/")) && url.contains("/status/") {
            return false
        }
        if url.contains("instagram.com/p/") || url.contains("instagram.com/reel/") || url.contains("instagram.com/stories/") {
            return false
        }
        return true
    }
}

private enum ArticleAudioStatus: String, Codable {
    case absent
    case ready
}

private struct ArticleAudioState: Codable, Equatable {
    let status: ArticleAudioStatus
    let audioPath: String?
    let durationMs: Int?
    let lastPositionMs: Int
    let completedAt: String?

    static let absent = ArticleAudioState(
        status: .absent,
        audioPath: nil,
        durationMs: nil,
        lastPositionMs: 0,
        completedAt: nil
    )
}

private struct StoredArticleAudioState: Codable {
    let formatVersion: Int
    let textHash: String
    let audioFileName: String
    var durationMs: Int?
    var lastPositionMs: Int
    var completedAt: String?
}

@MainActor
private final class ArticleAudioService {
    private let fileManager = FileManager.default
    private let iso8601 = ISO8601DateFormatter()
    private var activeSynthesizer: AVSpeechSynthesizer?

    func resolveState(
        slug: String,
        vaultPath: String,
        prepared: FfiPreparedArticleSpeech
    ) throws -> ArticleAudioState {
        try ensureAudioDirectory(vaultPath: vaultPath)

        guard let stored = try readStoredState(slug: slug, vaultPath: vaultPath) else {
            return .absent
        }
        guard stored.textHash == prepared.textHash else {
            try delete(slug: slug, vaultPath: vaultPath)
            return .absent
        }

        let audioURL = audioURL(slug: slug, vaultPath: vaultPath, fileName: stored.audioFileName)
        guard fileManager.fileExists(atPath: audioURL.path) else {
            try delete(slug: slug, vaultPath: vaultPath)
            return .absent
        }

        return ArticleAudioState(
            status: .ready,
            audioPath: audioURL.path,
            durationMs: stored.durationMs,
            lastPositionMs: stored.lastPositionMs,
            completedAt: stored.completedAt
        )
    }

    func generate(
        slug: String,
        vaultPath: String,
        prepared: FfiPreparedArticleSpeech
    ) async throws -> ArticleAudioState {
        try delete(slug: slug, vaultPath: vaultPath)
        try ensureAudioDirectory(vaultPath: vaultPath)

        let audioFileName = "\(slug).caf"
        let outputURL = audioURL(slug: slug, vaultPath: vaultPath, fileName: audioFileName)
        let durationMs = try await synthesizeToFile(
            text: prepared.speakableText,
            languageTag: prepared.languageTag,
            outputURL: outputURL
        )

        let stored = StoredArticleAudioState(
            formatVersion: 1,
            textHash: prepared.textHash,
            audioFileName: audioFileName,
            durationMs: durationMs,
            lastPositionMs: 0,
            completedAt: nil
        )
        try writeStoredState(stored, slug: slug, vaultPath: vaultPath)

        return ArticleAudioState(
            status: .ready,
            audioPath: outputURL.path,
            durationMs: durationMs,
            lastPositionMs: 0,
            completedAt: nil
        )
    }

    func updatePosition(
        slug: String,
        vaultPath: String,
        positionMs: Int,
        durationMs: Int?,
        completed: Bool
    ) throws -> ArticleAudioState {
        guard var stored = try readStoredState(slug: slug, vaultPath: vaultPath) else {
            return .absent
        }

        let audioURL = audioURL(slug: slug, vaultPath: vaultPath, fileName: stored.audioFileName)
        guard fileManager.fileExists(atPath: audioURL.path) else {
            try delete(slug: slug, vaultPath: vaultPath)
            return .absent
        }

        if let durationMs {
            stored.durationMs = durationMs
        }

        if completed {
            stored.lastPositionMs = 0
            stored.completedAt = iso8601.string(from: Date())
        } else {
            stored.lastPositionMs = positionMs
            stored.completedAt = nil
        }

        try writeStoredState(stored, slug: slug, vaultPath: vaultPath)

        return ArticleAudioState(
            status: .ready,
            audioPath: audioURL.path,
            durationMs: stored.durationMs,
            lastPositionMs: stored.lastPositionMs,
            completedAt: stored.completedAt
        )
    }

    func delete(slug: String, vaultPath: String) throws {
        let stateURL = stateURL(slug: slug, vaultPath: vaultPath)
        if fileManager.fileExists(atPath: stateURL.path) {
            try fileManager.removeItem(at: stateURL)
        }

        let audioURL = audioURL(slug: slug, vaultPath: vaultPath, fileName: "\(slug).caf")
        if fileManager.fileExists(atPath: audioURL.path) {
            try fileManager.removeItem(at: audioURL)
        }
    }

    private func ensureAudioDirectory(vaultPath: String) throws {
        try fileManager.createDirectory(
            at: storageRoot(vaultPath: vaultPath),
            withIntermediateDirectories: true,
            attributes: nil
        )
    }

    private func storageRoot(vaultPath: String) -> URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let vaultHash = SHA256.hash(data: Data(vaultPath.utf8))
            .compactMap { String(format: "%02x", $0) }
            .joined()
        return base
            .appendingPathComponent("Mine", isDirectory: true)
            .appendingPathComponent("ArticleAudio", isDirectory: true)
            .appendingPathComponent(vaultHash, isDirectory: true)
    }

    private func stateURL(slug: String, vaultPath: String) -> URL {
        storageRoot(vaultPath: vaultPath).appendingPathComponent("\(slug).json")
    }

    private func audioURL(slug: String, vaultPath: String, fileName: String) -> URL {
        storageRoot(vaultPath: vaultPath).appendingPathComponent(fileName)
    }

    private func readStoredState(slug: String, vaultPath: String) throws -> StoredArticleAudioState? {
        let path = stateURL(slug: slug, vaultPath: vaultPath)
        guard fileManager.fileExists(atPath: path.path) else {
            return nil
        }
        let data = try Data(contentsOf: path)
        return try JSONDecoder().decode(StoredArticleAudioState.self, from: data)
    }

    private func writeStoredState(
        _ state: StoredArticleAudioState,
        slug: String,
        vaultPath: String
    ) throws {
        let url = stateURL(slug: slug, vaultPath: vaultPath)
        let data = try JSONEncoder().encode(state)
        try data.write(to: url, options: .atomic)
    }

    private func synthesizeToFile(
        text: String,
        languageTag: String?,
        outputURL: URL
    ) async throws -> Int? {
        let tempURL = outputURL.deletingPathExtension().appendingPathExtension("tmp.caf")
        if fileManager.fileExists(atPath: tempURL.path) {
            try fileManager.removeItem(at: tempURL)
        }
        if fileManager.fileExists(atPath: outputURL.path) {
            try fileManager.removeItem(at: outputURL)
        }

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = preferredVoice(for: languageTag)

        let synthesizer = AVSpeechSynthesizer()
        activeSynthesizer = synthesizer
        defer { activeSynthesizer = nil }

        var audioFile: AVAudioFile?
        var totalFrames: AVAudioFramePosition = 0

        let durationMs = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int?, Error>) in
            var isFinished = false

            synthesizer.write(utterance) { buffer in
                guard let pcmBuffer = buffer as? AVAudioPCMBuffer else {
                    if !isFinished {
                        isFinished = true
                        continuation.resume(throwing: NSError(
                            domain: "MineArticleAudio",
                            code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "macOS speech synthesis returned an unexpected buffer"]
                        ))
                    }
                    return
                }

                if pcmBuffer.frameLength == 0 {
                    if !isFinished {
                        isFinished = true
                        do {
                            try self.fileManager.moveItem(at: tempURL, to: outputURL)
                            let duration = audioFile.map {
                                Int((Double(totalFrames) / $0.processingFormat.sampleRate) * 1000.0)
                            }
                            continuation.resume(returning: duration)
                        } catch {
                            continuation.resume(throwing: error)
                        }
                    }
                    return
                }

                do {
                    if audioFile == nil {
                        audioFile = try AVAudioFile(
                            forWriting: tempURL,
                            settings: pcmBuffer.format.settings,
                            commonFormat: pcmBuffer.format.commonFormat,
                            interleaved: pcmBuffer.format.isInterleaved
                        )
                    }
                    try audioFile?.write(from: pcmBuffer)
                    totalFrames += AVAudioFramePosition(pcmBuffer.frameLength)
                } catch {
                    if !isFinished {
                        isFinished = true
                        continuation.resume(throwing: error)
                    }
                }
            }
        }

        return durationMs
    }

    private func preferredVoice(for languageTag: String?) -> AVSpeechSynthesisVoice? {
        if let languageTag {
            if let voice = AVSpeechSynthesisVoice(language: languageTag) {
                return voice
            }
            let prefix = languageTag.split(separator: "-").first.map(String.init)?.lowercased()
            if let prefix {
                return AVSpeechSynthesisVoice.speechVoices().first {
                    $0.language.lowercased().hasPrefix(prefix)
                }
            }
        }

        if let preferredLanguage = Locale.current.language.languageCode?.identifier {
            return AVSpeechSynthesisVoice(language: preferredLanguage)
        }

        return AVSpeechSynthesisVoice(language: Locale.current.identifier)
    }
}

@MainActor
private final class ArticleAudioController: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var state: ArticleAudioState = .absent
    @Published private(set) var isLoading = true
    @Published private(set) var isGenerating = false
    @Published private(set) var isRemoving = false
    @Published private(set) var isPlaying = false
    @Published private(set) var currentTimeMs = 0
    @Published private(set) var durationMs: Int?
    @Published private(set) var errorMessage: String?

    let block: FfiLightBlock
    let vaultPath: String
    let service = ArticleAudioService()

    private var vault: ArenaVault?
    private var player: AVAudioPlayer?
    private var progressTimer: Timer?

    init(block: FfiLightBlock, vaultPath: String) {
        self.block = block
        self.vaultPath = vaultPath
    }

    var isSupported: Bool {
        ArticleAudioSupport.supports(block: block)
    }

    var isReady: Bool {
        state.status == .ready && state.audioPath != nil
    }

    var primaryActionTitle: String {
        if isLoading {
            return "Loading…"
        }
        if isGenerating {
            return "Creating Audio…"
        }
        if errorMessage != nil {
            return "Retry"
        }
        return "Create Audio"
    }

    var progressFraction: CGFloat {
        guard let durationMs, durationMs > 0 else { return 0 }
        return CGFloat(min(1, max(0, Double(currentTimeMs) / Double(durationMs))))
    }

    func load(using vaultModel: VaultViewModel) async {
        guard isSupported else {
            isLoading = false
            return
        }
        guard let vault = vaultModel.currentVault else {
            errorMessage = "Vault unavailable"
            isLoading = false
            return
        }

        self.vault = vault
        isLoading = true
        errorMessage = nil

        do {
            let prepared = try vault.prepareArticleSpeech(slug: block.slug)
            let nextState = try service.resolveState(
                slug: block.slug,
                vaultPath: vaultPath,
                prepared: prepared
            )
            apply(nextState)
        } catch {
            state = .absent
            clearPlayer()
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    func generateAudio() async {
        guard let vault else { return }
        isGenerating = true
        errorMessage = nil

        do {
            let prepared = try vault.prepareArticleSpeech(slug: block.slug)
            let nextState = try await service.generate(
                slug: block.slug,
                vaultPath: vaultPath,
                prepared: prepared
            )
            apply(nextState)
        } catch {
            errorMessage = error.localizedDescription
        }

        isGenerating = false
    }

    func removeAudio() {
        guard isReady else { return }
        isRemoving = true
        errorMessage = nil
        clearPlayer()

        do {
            try service.delete(slug: block.slug, vaultPath: vaultPath)
            state = .absent
            currentTimeMs = 0
            durationMs = nil
        } catch {
            errorMessage = error.localizedDescription
        }

        isRemoving = false
    }

    func togglePlayback() {
        guard isReady else { return }
        if isPlaying {
            pauseAndPersist(completed: false)
            return
        }

        guard let player else {
            return
        }

        errorMessage = nil
        if player.play() {
            isPlaying = true
            startProgressTimer()
        } else {
            errorMessage = "Playback failed"
        }
    }

    func handleDisappear() {
        guard isReady else { return }
        pauseAndPersist(completed: false)
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        isPlaying = false
        stopProgressTimer()
        player.currentTime = 0
        persistPosition(completed: true)
        currentTimeMs = 0
    }

    private func apply(_ nextState: ArticleAudioState) {
        state = nextState
        currentTimeMs = nextState.lastPositionMs
        durationMs = nextState.durationMs

        guard nextState.status == .ready, let audioPath = nextState.audioPath else {
            clearPlayer()
            return
        }

        do {
            let player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: audioPath))
            player.delegate = self
            player.prepareToPlay()
            if nextState.lastPositionMs > 0 {
                player.currentTime = Double(nextState.lastPositionMs) / 1000.0
            }
            self.player = player

            let resolvedDuration = Int(player.duration * 1000.0)
            durationMs = nextState.durationMs ?? resolvedDuration
            if nextState.durationMs == nil {
                state = (try? service.updatePosition(
                    slug: block.slug,
                    vaultPath: vaultPath,
                    positionMs: nextState.lastPositionMs,
                    durationMs: resolvedDuration,
                    completed: false
                )) ?? nextState
            }
        } catch {
            clearPlayer()
            errorMessage = error.localizedDescription
        }
    }

    private func pauseAndPersist(completed: Bool) {
        player?.pause()
        isPlaying = false
        stopProgressTimer()
        persistPosition(completed: completed)
    }

    private func persistPosition(completed: Bool) {
        guard isReady else { return }
        let nextDuration = durationMs ?? player.map { Int($0.duration * 1000.0) }
        let nextPosition = completed ? 0 : Int((player?.currentTime ?? Double(currentTimeMs) / 1000.0) * 1000.0)
        do {
            let nextState = try service.updatePosition(
                slug: block.slug,
                vaultPath: vaultPath,
                positionMs: nextPosition,
                durationMs: nextDuration,
                completed: completed
            )
            state = nextState
            currentTimeMs = nextState.lastPositionMs
            durationMs = nextState.durationMs
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func startProgressTimer() {
        stopProgressTimer()
        progressTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self, let player = self.player else { return }
            self.currentTimeMs = Int(player.currentTime * 1000.0)
            if self.durationMs == nil {
                self.durationMs = Int(player.duration * 1000.0)
            }
        }
    }

    private func stopProgressTimer() {
        progressTimer?.invalidate()
        progressTimer = nil
    }

    private func clearPlayer() {
        player?.stop()
        player = nil
        isPlaying = false
        stopProgressTimer()
    }
}
