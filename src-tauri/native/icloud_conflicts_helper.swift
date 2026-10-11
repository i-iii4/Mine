// The unresolved iCloud conflict versions of a space's notes.
//
// iCloud keeps one file in the folder and holds the losing edits of a
// conflict as NSFileVersion conflict versions, invisible to Mine and to
// Obsidian (TN2336). This helper lists them, copies one out and settles
// them. It needs no iCloud entitlement: a process without one sees, reads and
// resolves the versions of files in iCloud Drive (live check of 11.10.2026,
// SPEC_ICLOUD_CONFLICTS.md, «Результаты живой проверки»). Every access to a
// file goes through NSFileCoordinator, as TN2336 requires.
//
// Contract (SPEC_ICLOUD_CONFLICTS.md, ВК5); every answer is one JSON line on
// stdout:
//   scan                       absolute .md paths on stdin, one per line. One
//                              line per file with conflict versions:
//                              {"path", "current": {"modified", "device"},
//                               "versions": [{"token", "modified", "device"}]}
//                              and last {"done": true, "checked": N,
//                              "failed": [path…]}; a failed path got no
//                              answer and keeps whatever Mine knew of it.
//   read <path> <token> <dest> the version's bytes written to dest (a new
//                              file): {"sha256": "…"}
//   settle <path> <token>…     each version marked resolved and removed:
//                              {"settled": [token…], "missing": [token…]}
// A failure is {"error": "<kind>", "message": "…"} and exit status 1.
//
// `scan` never reads contents: it asks the conflict key first and calls
// NSFileVersion only for a flagged file (the key matched the versions on every
// file of the live check), under coordination limited to metadata, so a file
// whose contents are in iCloud stays there. `settle` removes only the versions
// it is given, never `removeOtherVersionsOfItem`: that also erases the file's
// ordinary version history.
//
// A token is found again among the file's unresolved conflict versions, by
// archiving each identifier the same way and comparing, never by unarchiving
// the token: the identifier is an object of a private class
// (`GSDocumentIdentifier`) that a fresh process has not loaded, and the
// unarchiver refuses it (checked 11.10.2026). The comparison also means
// `read` and `settle` can only ever reach a conflict version: a token of the
// file's ordinary history matches nothing.

import CryptoKit
import Foundation

let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
        FileHandle.standardError.write(Data("icloud-conflicts-helper: unencodable answer\n".utf8))
        exit(1)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ kind: String, _ message: String) -> Never {
    emit(["error": kind, "message": message])
    exit(1)
}

func date(_ value: Date?) -> Any {
    value.map { isoFormatter.string(from: $0) } ?? NSNull()
}

/// The token of a version: its persistent identifier, archived and base64
/// encoded. The same version gives the same token in every process.
func tokenOf(_ version: NSFileVersion) -> String? {
    guard let data = try? NSKeyedArchiver.archivedData(
        withRootObject: version.persistentIdentifier,
        requiringSecureCoding: false
    ) else { return nil }
    return data.base64EncodedString()
}

/// The unresolved conflict version of `url` whose token is `token`.
func conflictVersion(of url: URL, token: String) -> NSFileVersion? {
    (NSFileVersion.unresolvedConflictVersionsOfItem(at: url) ?? []).first { version in
        tokenOf(version) == token
    }
}

/// The modification date of the file in the folder, for a current version
/// that names none.
func fileModified(_ url: URL) -> Date? {
    try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
}

func scan() {
    var checked = 0
    var failed: [String] = []
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        // A fresh URL per file: no resource value cached by an earlier ask.
        let url = URL(fileURLWithPath: line)
        guard FileManager.default.fileExists(atPath: line) else {
            // A file that is gone has no conflict.
            checked += 1
            continue
        }
        let flagged: Bool
        do {
            let values = try url.resourceValues(forKeys: [.ubiquitousItemHasUnresolvedConflictsKey])
            flagged = values.ubiquitousItemHasUnresolvedConflicts == true
        } catch {
            failed.append(line)
            continue
        }
        if !flagged {
            checked += 1
            continue
        }
        var record: [String: Any]?
        var unreadable = false
        var coordinationError: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(
            readingItemAt: url,
            options: [.immediatelyAvailableMetadataOnly],
            error: &coordinationError
        ) { coordinated in
            let versions = NSFileVersion.unresolvedConflictVersionsOfItem(at: coordinated) ?? []
            if versions.isEmpty { return }
            let current = NSFileVersion.currentVersionOfItem(at: coordinated)
            var described: [[String: Any]] = []
            for version in versions {
                guard let token = tokenOf(version) else {
                    unreadable = true
                    return
                }
                described.append([
                    "token": token,
                    "modified": date(version.modificationDate),
                    "device": version.localizedNameOfSavingComputer ?? NSNull(),
                ])
            }
            record = [
                "path": line,
                "current": [
                    "modified": date(current?.modificationDate ?? fileModified(coordinated)),
                    "device": current?.localizedNameOfSavingComputer ?? NSNull(),
                ],
                "versions": described,
            ]
        }
        if coordinationError != nil || unreadable {
            failed.append(line)
            continue
        }
        checked += 1
        if let record { emit(record) }
    }
    emit(["done": true, "checked": checked, "failed": failed])
}

func read(path: String, token: String, destination: String) {
    let url = URL(fileURLWithPath: path)
    var bytes: Data?
    var failure: (String, String)?
    var coordinationError: NSError?
    NSFileCoordinator(filePresenter: nil).coordinate(
        readingItemAt: url,
        options: [.withoutChanges],
        error: &coordinationError
    ) { coordinated in
        guard let version = conflictVersion(of: coordinated, token: token) else {
            failure = ("version_missing", "the version is no longer among the file's conflict versions")
            return
        }
        do {
            bytes = try Data(contentsOf: version.url)
        } catch {
            failure = ("read_failed", error.localizedDescription)
        }
    }
    if let coordinationError {
        fail("coordination_failed", coordinationError.localizedDescription)
    }
    if let failure { fail(failure.0, failure.1) }
    guard let bytes else { fail("read_failed", "the version gave no bytes") }
    do {
        try bytes.write(to: URL(fileURLWithPath: destination), options: [.withoutOverwriting])
    } catch {
        fail("write_failed", error.localizedDescription)
    }
    let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    emit(["sha256": digest])
}

func settle(path: String, tokens: [String]) {
    let url = URL(fileURLWithPath: path)
    var settled: [String] = []
    var missing: [String] = []
    var failure: (String, String)?
    var coordinationError: NSError?
    NSFileCoordinator(filePresenter: nil).coordinate(
        writingItemAt: url,
        options: [],
        error: &coordinationError
    ) { coordinated in
        for token in tokens {
            guard let version = conflictVersion(of: coordinated, token: token) else {
                // Another device resolved it already.
                missing.append(token)
                continue
            }
            version.isResolved = true
            do {
                try version.remove()
                settled.append(token)
            } catch {
                failure = ("remove_failed", error.localizedDescription)
                return
            }
        }
    }
    if let coordinationError {
        fail("coordination_failed", coordinationError.localizedDescription)
    }
    if let failure { fail(failure.0, failure.1) }
    emit(["settled": settled, "missing": missing])
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "scan" where arguments.count == 1:
    scan()
case "read" where arguments.count == 4:
    read(path: arguments[1], token: arguments[2], destination: arguments[3])
case "settle" where arguments.count >= 3:
    settle(path: arguments[1], tokens: Array(arguments.dropFirst(2)))
default:
    FileHandle.standardError.write(Data(
        "usage: icloud-conflicts-helper scan | read <path> <token> <dest> | settle <path> <token>…\n".utf8
    ))
    emit(["error": "usage", "message": "unknown command or wrong arguments"])
    exit(2)
}
