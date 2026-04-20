import AppKit
import AVFoundation
import Foundation

private let targetSampleRate: Double = 44_100
private let targetChannelCount: AVAudioChannelCount = 1
private let debugLoggingEnabled = ProcessInfo.processInfo.environment["ARTICLE_AUDIO_HELPER_DEBUG"] == "1"

struct ArticleAudioHelperRequest: Codable {
    let text: String
    let languageTag: String?
    let preferredVoiceId: String?
    let outputPath: String

    enum CodingKeys: String, CodingKey {
        case text
        case languageTag = "language_tag"
        case preferredVoiceId = "preferred_voice_id"
        case outputPath = "output_path"
    }
}

struct ArticleAudioHelperResponse: Codable {
    let durationMs: Int
    let resolvedVoiceId: String
    let resolvedVoiceName: String

    enum CodingKeys: String, CodingKey {
        case durationMs = "duration_ms"
        case resolvedVoiceId = "resolved_voice_id"
        case resolvedVoiceName = "resolved_voice_name"
    }
}

enum ArticleAudioHelperError: LocalizedError {
    case invalidRequest
    case unavailableVoice
    case invalidOutputPath
    case synthesisReturnedUnexpectedBuffer
    case synthesisProducedNoAudio
    case failedToCreateConverter
    case failedToCreatePCMBuffer
    case conversionFailed(String)
    case applicationDidNotFinish

    var errorDescription: String? {
        switch self {
        case .invalidRequest:
            return "failed to decode article-audio helper request"
        case .unavailableVoice:
            return "no compatible Apple speech voice is available"
        case .invalidOutputPath:
            return "helper received an invalid output path"
        case .synthesisReturnedUnexpectedBuffer:
            return "macOS speech synthesis returned a non-PCM audio buffer"
        case .synthesisProducedNoAudio:
            return "macOS speech synthesis produced zero audio frames"
        case .failedToCreateConverter:
            return "failed to create AVAudioConverter for article audio synthesis"
        case .failedToCreatePCMBuffer:
            return "failed to allocate target PCM buffer for article audio synthesis"
        case let .conversionFailed(message):
            return "article audio sample-rate conversion failed: \(message)"
        case .applicationDidNotFinish:
            return "article-audio helper exited before synthesis completed"
        }
    }
}

private func debugLog(_ message: String) {
    guard debugLoggingEnabled, let data = "[article-audio-helper] \(message)\n".data(using: .utf8) else {
        return
    }
    FileHandle.standardError.write(data)
}

final class ArticleAudioSynthesisController: NSObject, AVSpeechSynthesizerDelegate {
    private let request: ArticleAudioHelperRequest
    private let targetFormat: AVAudioFormat
    private var synth: AVSpeechSynthesizer?
    private var outputURL: URL?
    private var sourceFile: AVAudioFile?
    private var sourceFormat: AVAudioFormat?
    private var tempSourceURL: URL?
    private var resolvedVoice: AVSpeechSynthesisVoice?
    private(set) var response: ArticleAudioHelperResponse?
    private(set) var error: Error?
    private var totalFrames: AVAudioFramePosition = 0

    init(request: ArticleAudioHelperRequest) {
        self.request = request
        self.targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: targetChannelCount,
            interleaved: true
        )!
    }

    func start() {
        do {
            debugLog("start")
            guard !request.outputPath.isEmpty else {
                throw ArticleAudioHelperError.invalidOutputPath
            }

            let outputURL = URL(fileURLWithPath: request.outputPath, isDirectory: false)
            self.outputURL = outputURL
            let fileManager = FileManager.default
            if fileManager.fileExists(atPath: outputURL.path) {
                try fileManager.removeItem(at: outputURL)
            }

            guard let voice = resolveVoice(
                languageTag: request.languageTag,
                preferredVoiceId: request.preferredVoiceId
            ) else {
                throw ArticleAudioHelperError.unavailableVoice
            }
            resolvedVoice = voice
            debugLog("resolved voice id=\(voice.identifier) name=\(voice.name)")

            let utterance = AVSpeechUtterance(string: request.text)
            utterance.voice = voice

            let synth = AVSpeechSynthesizer()
            self.synth = synth
            synth.delegate = self
            debugLog("starting write")
            synth.write(utterance) { [weak self] buffer in
                self?.handleSynthesizedBuffer(buffer)
            }
        } catch {
            finish(with: .failure(error))
        }
    }

    func speechSynthesizer(_ sender: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        debugLog("didFinish totalFrames=\(totalFrames)")
        guard response == nil, error == nil else {
            return
        }

        guard totalFrames > 0 else {
            finish(with: .failure(ArticleAudioHelperError.synthesisProducedNoAudio))
            return
        }

        guard let voice = resolvedVoice else {
            finish(with: .failure(ArticleAudioHelperError.unavailableVoice))
            return
        }

        do {
            sourceFile = nil
            try convertBufferedSourceToOutput()
            let sampleRate = sourceFormat?.sampleRate ?? targetFormat.sampleRate
            let durationMs = Int((Double(totalFrames) / sampleRate) * 1000.0)
            let response = ArticleAudioHelperResponse(
                durationMs: durationMs,
                resolvedVoiceId: voice.identifier,
                resolvedVoiceName: voice.name
            )
            finish(with: .success(response))
        } catch {
            finish(with: .failure(error))
        }
    }

    func speechSynthesizer(_ sender: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        debugLog("didCancel")
        finish(with: .failure(ArticleAudioHelperError.applicationDidNotFinish))
    }

    private func handleSynthesizedBuffer(_ buffer: AVAudioBuffer) {
        guard response == nil, error == nil else {
            return
        }

        guard let pcmBuffer = buffer as? AVAudioPCMBuffer else {
            finish(with: .failure(ArticleAudioHelperError.synthesisReturnedUnexpectedBuffer))
            return
        }

        debugLog(
            "buffer frameLength=\(pcmBuffer.frameLength) sampleRate=\(pcmBuffer.format.sampleRate) channels=\(pcmBuffer.format.channelCount)"
        )
        if pcmBuffer.frameLength == 0 {
            return
        }

        do {
            try appendSourceBuffer(pcmBuffer)
            totalFrames += AVAudioFramePosition(pcmBuffer.frameLength)
        } catch {
            finish(with: .failure(error))
        }
    }

    private func appendSourceBuffer(_ buffer: AVAudioPCMBuffer) throws {
        if sourceFile == nil {
            guard let outputURL else {
                throw ArticleAudioHelperError.invalidOutputPath
            }

            let tempSourceURL = outputURL
                .deletingLastPathComponent()
                .appendingPathComponent(".\(outputURL.deletingPathExtension().lastPathComponent).source.caf")
            self.tempSourceURL = tempSourceURL
            sourceFormat = buffer.format

            let fileManager = FileManager.default
            if fileManager.fileExists(atPath: tempSourceURL.path) {
                try fileManager.removeItem(at: tempSourceURL)
            }

            sourceFile = try AVAudioFile(
                forWriting: tempSourceURL,
                settings: buffer.format.settings,
                commonFormat: buffer.format.commonFormat,
                interleaved: buffer.format.isInterleaved
            )
            debugLog(
                "opened temp source file format=\(buffer.format.commonFormat.rawValue) sr=\(buffer.format.sampleRate) interleaved=\(buffer.format.isInterleaved)"
            )
        }

        try sourceFile?.write(from: buffer)
    }

    private func convertBufferedSourceToOutput() throws {
        guard let tempSourceURL, let outputURL else {
            throw ArticleAudioHelperError.invalidOutputPath
        }

        defer {
            try? FileManager.default.removeItem(at: tempSourceURL)
            self.tempSourceURL = nil
        }

        let inputFile = try AVAudioFile(forReading: tempSourceURL)
        let inputFormat = inputFile.processingFormat
        debugLog(
            "converting buffered source from sr=\(inputFormat.sampleRate) ch=\(inputFormat.channelCount) to sr=\(targetFormat.sampleRate)"
        )

        if inputFormat == targetFormat {
            let outputFile = try AVAudioFile(
                forWriting: outputURL,
                settings: targetFormat.settings,
                commonFormat: targetFormat.commonFormat,
                interleaved: true
            )
            try copyPCMFile(inputFile, to: outputFile, format: inputFormat)
            return
        }

        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw ArticleAudioHelperError.failedToCreateConverter
        }

        let outputFile = try AVAudioFile(
            forWriting: outputURL,
            settings: targetFormat.settings,
            commonFormat: targetFormat.commonFormat,
            interleaved: true
        )

        let inputCapacity: AVAudioFrameCount = 4096
        let outputCapacity = AVAudioFrameCount(
            (Double(inputCapacity) * (targetFormat.sampleRate / inputFormat.sampleRate)).rounded(.up) + 512
        )
        var reachedEndOfInput = false
        var inputReadError: Error?

        conversionLoop: while true {
            guard let outputBuffer = AVAudioPCMBuffer(
                pcmFormat: targetFormat,
                frameCapacity: outputCapacity
            ) else {
                throw ArticleAudioHelperError.failedToCreatePCMBuffer
            }

            var conversionError: NSError?
            let status = converter.convert(to: outputBuffer, error: &conversionError) { _, outStatus in
                if reachedEndOfInput {
                    outStatus.pointee = .endOfStream
                    return nil
                }

                let framesRemaining = inputFile.length - inputFile.framePosition
                if framesRemaining <= 0 {
                    reachedEndOfInput = true
                    outStatus.pointee = .endOfStream
                    return nil
                }

                guard let inputBuffer = AVAudioPCMBuffer(
                    pcmFormat: inputFormat,
                    frameCapacity: inputCapacity
                ) else {
                    inputReadError = ArticleAudioHelperError.failedToCreatePCMBuffer
                    outStatus.pointee = .noDataNow
                    return nil
                }

                do {
                    let nextFrameCount = AVAudioFrameCount(min(Int64(inputCapacity), framesRemaining))
                    try inputFile.read(into: inputBuffer, frameCount: nextFrameCount)
                } catch {
                    inputReadError = error
                    outStatus.pointee = .noDataNow
                    return nil
                }

                if inputBuffer.frameLength == 0 {
                    reachedEndOfInput = true
                    outStatus.pointee = .endOfStream
                    return nil
                }

                outStatus.pointee = .haveData
                return inputBuffer
            }

            if let inputReadError {
                throw inputReadError
            }

            if let conversionError {
                throw ArticleAudioHelperError.conversionFailed(conversionError.localizedDescription)
            }

            if outputBuffer.frameLength > 0 {
                try outputFile.write(from: outputBuffer)
            }

            switch status {
            case .haveData, .inputRanDry:
                continue conversionLoop
            case .endOfStream:
                break conversionLoop
            case .error:
                throw ArticleAudioHelperError.conversionFailed("AVAudioConverter returned error")
            @unknown default:
                throw ArticleAudioHelperError.conversionFailed(
                    "AVAudioConverter returned unknown status \(status.rawValue)"
                )
            }
        }
    }

    private func copyPCMFile(
        _ inputFile: AVAudioFile,
        to outputFile: AVAudioFile,
        format: AVAudioFormat
    ) throws {
        let capacity: AVAudioFrameCount = 4096
        while true {
            let framesRemaining = inputFile.length - inputFile.framePosition
            if framesRemaining <= 0 {
                return
            }

            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
                throw ArticleAudioHelperError.failedToCreatePCMBuffer
            }
            let nextFrameCount = AVAudioFrameCount(min(Int64(capacity), framesRemaining))
            try inputFile.read(into: buffer, frameCount: nextFrameCount)
            try outputFile.write(from: buffer)
        }
    }

    private func finish(with result: Result<ArticleAudioHelperResponse, Error>) {
        if !Thread.isMainThread {
            DispatchQueue.main.async { [weak self] in
                self?.finish(with: result)
            }
            return
        }

        debugLog("finish on main thread")

        switch result {
        case let .success(response):
            self.response = response
        case let .failure(error):
            self.error = error
        }

        sourceFile = nil
        synth = nil
    }
}

@main
struct ArticleAudioHelperMain {
    static func main() {
        do {
            let request = try loadRequest()
            let application = NSApplication.shared
            application.setActivationPolicy(.prohibited)
            let controller = ArticleAudioSynthesisController(request: request)
            controller.start()

            while controller.response == nil, controller.error == nil {
                RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
            }

            if let error = controller.error {
                throw error
            }
            guard let response = controller.response else {
                throw ArticleAudioHelperError.applicationDidNotFinish
            }
            try writeResponse(response)
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            if let data = "\(message)\n".data(using: .utf8) {
                FileHandle.standardError.write(data)
            }
            exit(1)
        }
    }

    private static func loadRequest() throws -> ArticleAudioHelperRequest {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard !data.isEmpty else {
            throw ArticleAudioHelperError.invalidRequest
        }
        return try JSONDecoder().decode(ArticleAudioHelperRequest.self, from: data)
    }

    private static func writeResponse(_ response: ArticleAudioHelperResponse) throws {
        let data = try JSONEncoder().encode(response)
        FileHandle.standardOutput.write(data)
    }
}

private func resolveVoice(
    languageTag: String?,
    preferredVoiceId: String?
) -> AVSpeechSynthesisVoice? {
    let installedVoices = AVSpeechSynthesisVoice.speechVoices()
    if let preferredVoiceId,
       let exactVoice = installedVoices.first(where: { $0.identifier == preferredVoiceId }) {
        return exactVoice
    }

    if let languageTag,
       let exactLanguageVoice = installedVoices.first(where: {
           $0.language.caseInsensitiveCompare(languageTag) == .orderedSame
       }) {
        return exactLanguageVoice
    }

    if let prefix = languageTag?
        .split(separator: "-")
        .first?
        .lowercased(),
       let prefixVoice = installedVoices.first(where: {
           $0.language.lowercased().hasPrefix(prefix)
       }) {
        return prefixVoice
    }

    if let currentLanguageVoice = AVSpeechSynthesisVoice(
        language: AVSpeechSynthesisVoice.currentLanguageCode()
    ) {
        return currentLanguageVoice
    }

    return installedVoices.first
}
