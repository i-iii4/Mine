// The honest download state of one file iCloud keeps.
//
// Three truthful signals exist, and this helper uses only them; none of them
// is the file's path (SPEC_DEEP_AUDIT.md, Н7, Е5.2: a space on the iCloud
// Desktop has no `Mobile Documents` in its path, and its files were reported
// not managed). The file's flags: the kernel marks a dataless placeholder
// with SF_DATALESS (`ls -lO` shows `dataless`), the rule the app itself keeps
// (`storage/cloud_files.rs`). Whether iCloud keeps the file at all:
// FileManager.isUbiquitousItem, true for iCloud Drive and for the Desktop and
// Documents it syncs. And the system's published progress: while bird
// materializes a file it publishes an NSProgress for that URL — the exact
// channel Finder's download rings read — and subscribing to it needs no
// entitlements.
//
// What is deliberately NOT used: NSURL ubiquitous download-status keys, which
// report "current" for a dataless file on FileProvider-era macOS, and
// NSMetadataQuery ubiquitous scopes, which return nothing without an iCloud
// entitlement this app does not have. Both were tried against a really
// evicted file and both lied or went silent. A percent is reported only when
// the system publishes one; it is never derived, never invented.
// See SPEC_CLOUD_STORAGE.md Х3, Х4.
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

/// SF_DATALESS of <sys/stat.h>: the file is a dataless placeholder.
let datalessFlag: UInt32 = 0x4000_0000

/// Dataless check by the file's flags, which only the kernel sets. Reading
/// contents would start the very download this helper observes, so only
/// `stat` is allowed here.
func isDataless(_ path: String) -> Bool? {
    var st = stat()
    guard stat(path, &st) == 0 else { return nil }
    return st.st_flags & datalessFlag != 0
}

guard let dataless = isDataless(path) else {
    emit(Output(status: "unknown", percent: nil))
}
if !dataless {
    if FileManager.default.isUbiquitousItem(at: url) {
        emit(Output(status: "current", percent: 100))
    }
    emit(Output(status: "not_managed", percent: nil))
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
