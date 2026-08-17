// The honest download state of one iCloud Drive file.
//
// Two truthful signals exist for CloudDocs files, and this helper uses only
// them. Allocation: a dataless file reports its full logical size with zero
// allocated blocks — the same signature the app's own eviction detection
// trusts. And the system's published progress: while bird materializes a file
// it publishes an NSProgress for that URL — the exact channel Finder's
// download rings read — and subscribing to it needs no entitlements.
//
// What is deliberately NOT used: NSURL ubiquitous resource keys, which report
// "current" for a dataless file on FileProvider-era macOS, and
// NSMetadataQuery ubiquitous scopes, which return nothing without an iCloud
// entitlement this app does not have. Both were tried against a really
// evicted file and both lied or went silent. A percent is reported only when
// the system publishes one; it is never derived, never invented.
// See SPEC_CLOUD_STORAGE.md Х4.
//
// Contract: argv[1] is an absolute file path. One JSON line on stdout:
//   {"status":"current"|"downloading"|"not_downloaded"|"not_managed"|"unknown",
//    "percent": 0.0–100.0 | null}

import Foundation

struct Output: Codable {
    let status: String
    let percent: Double?
}

func emit(_ output: Output) -> Never {
    let data = try! JSONEncoder().encode(output)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: icloud-progress-helper <absolute-path>\n".utf8))
    exit(2)
}
let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)

guard path.contains("/Mobile Documents/") else {
    emit(Output(status: "not_managed", percent: nil))
}

/// Dataless check by allocation, the one filesystem signal that does not lie:
/// full logical size, zero allocated blocks. Reading contents would start the
/// very download this helper observes, so only `stat` is allowed here.
func isDataless(_ path: String) -> Bool? {
    var st = stat()
    guard stat(path, &st) == 0 else { return nil }
    return st.st_size > 0 && st.st_blocks == 0
}

guard let dataless = isDataless(path) else {
    emit(Output(status: "unknown", percent: nil))
}
if !dataless {
    emit(Output(status: "current", percent: 100))
}

// Contents are absent. If the system is materializing the file right now it
// publishes a progress for this URL; subscribe and report the freshest
// fraction it hands over within the sampling window.
final class Sampler {
    var latest: Double?
}
let sampler = Sampler()

let subscriber = Progress.addSubscriber(forFileURL: url) { progress in
    sampler.latest = progress.fractionCompleted * 100
    progress.addObserver(
        ProgressWatcher(sampler: sampler),
        forKeyPath: "fractionCompleted",
        options: [.new],
        context: nil
    )
    return nil
}

final class ProgressWatcher: NSObject {
    let sampler: Sampler
    init(sampler: Sampler) {
        self.sampler = sampler
        super.init()
    }
    override func observeValue(
        forKeyPath keyPath: String?,
        of object: Any?,
        change: [NSKeyValueChangeKey: Any]?,
        context: UnsafeMutableRawPointer?
    ) {
        if let progress = object as? Progress {
            sampler.latest = progress.fractionCompleted * 100
        }
    }
}

DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
    Progress.removeSubscriber(subscriber)
    if let percent = sampler.latest {
        emit(Output(status: "downloading", percent: min(max(percent, 0), 100)))
    }
    // No publisher inside the window: contents absent and nothing in flight.
    emit(Output(status: "not_downloaded", percent: nil))
}

RunLoop.main.run()
