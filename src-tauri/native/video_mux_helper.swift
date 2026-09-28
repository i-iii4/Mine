// Joins a video-only file and an audio-only file into one MP4 without
// re-encoding. YouTube delivers 720p and above as separate streams, and Mine
// ships no ffmpeg; AVFoundation's passthrough export does the same job with
// what macOS already has. See SPEC_MEDIA_ASSET_ACTIONS.md «Download Media».
//
// Usage: video-mux-helper <video> <audio> <output.mp4> <duration-seconds>
//
// The duration comes from the source's own metadata. For YouTube's fragmented
// MP4 files AVFoundation reports every track at twice its real length, and a
// composition built from that length ends in an empty half.
//
// Exit 0 on success; otherwise a one-line reason on stderr and a non-zero code.

import AVFoundation
import Foundation

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

let arguments = CommandLine.arguments
guard arguments.count == 5, let seconds = Double(arguments[4]), seconds > 0 else {
    fail("usage: video-mux-helper <video> <audio> <output.mp4> <duration-seconds>", code: 64)
}
let videoURL = URL(fileURLWithPath: arguments[1])
let audioURL = URL(fileURLWithPath: arguments[2])
let outputURL = URL(fileURLWithPath: arguments[3])

Task {
    do {
        let video = AVURLAsset(url: videoURL)
        let audio = AVURLAsset(url: audioURL)
        guard let videoTrack = try await video.loadTracks(withMediaType: .video).first else {
            fail("the video file has no video track")
        }
        guard let audioTrack = try await audio.loadTracks(withMediaType: .audio).first else {
            fail("the audio file has no audio track")
        }
        let videoRange = try await videoTrack.load(.timeRange)
        let audioRange = try await audioTrack.load(.timeRange)
        let length = CMTime(seconds: seconds, preferredTimescale: 600)

        let composition = AVMutableComposition()
        guard
            let composedVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
            let composedAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        else {
            fail("could not create composition tracks")
        }
        try composedVideo.insertTimeRange(
            CMTimeRange(start: videoRange.start, duration: CMTimeMinimum(length, videoRange.duration)),
            of: videoTrack,
            at: .zero
        )
        composedVideo.preferredTransform = try await videoTrack.load(.preferredTransform)
        try composedAudio.insertTimeRange(
            CMTimeRange(start: audioRange.start, duration: CMTimeMinimum(length, audioRange.duration)),
            of: audioTrack,
            at: .zero
        )

        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
            fail("passthrough export is not available for these streams")
        }
        try? FileManager.default.removeItem(at: outputURL)
        export.shouldOptimizeForNetworkUse = true
        try await export.export(to: outputURL, as: .mp4)
        exit(0)
    } catch {
        fail(error.localizedDescription)
    }
}

dispatchMain()
