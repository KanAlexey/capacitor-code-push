import Foundation
import ZIPFoundation

/// Where a diff starts from: a staged package's folder, or the store bundle. Copies the web root into `destination`,
/// which exists and is empty.
public typealias BaseSource = (_ destination: URL) throws -> Void

public enum Unzipper {
    /// Unzips `zip` into `destination`. An entry that is absolute, climbs out with `..` or is a symbolic link is
    /// refused: a zip from the server must not write, or point, outside the folder it is unpacked in.
    public static func unzip(_ zip: URL, to destination: URL) throws {
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let archive: Archive
        do {
            archive = try Archive(url: zip, accessMode: .read)
        } catch {
            throw CodePushError(CodePushError.invalidPackage, "Could not open the package: \(error)")
        }
        for entry in archive {
            if entry.type == .symlink {
                throw CodePushError(CodePushError.invalidPackage, "Refused a symbolic link in the package: \(entry.path)")
            }
            let target = try resolveInside(destination, entry.path)
            do {
                if entry.type == .directory {
                    try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
                } else {
                    _ = try archive.extract(entry, to: target)
                }
            } catch {
                throw CodePushError(CodePushError.invalidPackage, "Could not unzip \(entry.path): \(error)")
            }
        }
    }

    /// `relativePath` under `root`, or INVALID_PACKAGE when it would land anywhere else.
    public static func resolveInside(_ root: URL, _ relativePath: String) throws -> URL {
        let normalised = relativePath.replacingOccurrences(of: "\\", with: "/")
        let segments = normalised.split(separator: "/", omittingEmptySubsequences: false)
        let looksAbsolute = normalised.hasPrefix("/")
            || normalised.range(of: "^[A-Za-z]:", options: .regularExpression) != nil
        guard !looksAbsolute, !segments.contains("..") else {
            throw CodePushError(CodePushError.invalidPackage, "Refused path in package: \(relativePath)")
        }
        let base = root.standardizedFileURL
        let target = base.appendingPathComponent(normalised).standardizedFileURL
        guard target.path == base.path || target.path.hasPrefix(base.path + "/") else {
            throw CodePushError(CodePushError.invalidPackage, "Refused path in package: \(relativePath)")
        }
        return target
    }
}

/// Turns a downloaded zip into a staged package (DESIGN.md §11): unzip, apply a diff onto its base, find the web
/// root, check the hash of a diff, move the web root to `packages/<hash>/` and write the sidecar.
public final class PackageStager {
    public static let diffManifest = "hotcodepush.json"

    private let store: StateStore
    private let fileManager = FileManager.default

    public init(store: StateStore) {
        self.store = store
    }

    public func stage(zip: URL, metadata: PackageMetadata, base: BaseSource, publicKeyConfigured: Bool) throws {
        let packageHash = try StateStore.checkedHash(metadata.packageHash)
        if publicKeyConfigured {
            throw CodePushError(CodePushError.signatureUnsupported,
                                "A public key is configured, and this version cannot verify signatures; refusing to install.")
        }
        let unzipped = store.downloadDir.appendingPathComponent("unzipped", isDirectory: true)
        try? fileManager.removeItem(at: unzipped)
        try Unzipper.unzip(zip, to: unzipped)

        let manifest = unzipped.appendingPathComponent(Self.diffManifest)
        let releaseRoot: URL
        if fileManager.fileExists(atPath: manifest.path) {
            releaseRoot = try applyDiff(unzipped: unzipped, manifest: manifest, base: base)
            let computed = try PackageHasher.hash(directory: releaseRoot, prefix: releaseRoot.lastPathComponent)
            guard computed == packageHash else {
                throw CodePushError(CodePushError.hashMismatch,
                                    "The update contents failed the data integrity check: expected \(packageHash), got \(computed).")
            }
        } else {
            releaseRoot = try findWebRoot(unzipped)
        }
        if fileManager.fileExists(atPath: releaseRoot.appendingPathComponent(".codepushrelease").path) {
            CodePushLog.info("The update carries a signature, and no public key is configured to check it.")
        }

        let destination = try store.packageDir(packageHash)
        try? fileManager.removeItem(at: destination)
        try fileManager.createDirectory(at: store.packagesDir, withIntermediateDirectories: true)
        try fileManager.moveItem(at: releaseRoot, to: destination)
        try store.writeSidecar(metadata)
        try? fileManager.removeItem(at: store.downloadDir)
    }

    /// Copies the base into `merge/<release folder>`, lays the diff over it and deletes what it lists.
    private func applyDiff(unzipped: URL, manifest: URL, base: BaseSource) throws -> URL {
        let merge = store.downloadDir.appendingPathComponent("merge", isDirectory: true)
        try? fileManager.removeItem(at: merge)
        let folderName = topLevelDirectories(unzipped).count == 1 ? topLevelDirectories(unzipped)[0] : "www"
        let releaseRoot = merge.appendingPathComponent(folderName, isDirectory: true)
        try fileManager.createDirectory(at: releaseRoot, withIntermediateDirectories: true)
        try base(releaseRoot)

        for relative in fileManager.subpaths(atPath: unzipped.path) ?? [] where relative != Self.diffManifest {
            var isDirectory: ObjCBool = false
            let source = unzipped.appendingPathComponent(relative)
            guard fileManager.fileExists(atPath: source.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                continue
            }
            let target = try Unzipper.resolveInside(merge, relative)
            try fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? fileManager.removeItem(at: target)
            try fileManager.copyItem(at: source, to: target)
        }

        let deleted: [String]
        do {
            let json = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any]
            deleted = json?["deletedFiles"] as? [String] ?? []
        } catch {
            throw CodePushError(CodePushError.invalidPackage, "Unreadable \(Self.diffManifest): \(error)")
        }
        for path in deleted {
            // Resolved outside the `try?`, which would otherwise swallow the refusal of a path leaving the folder.
            let target = try Unzipper.resolveInside(merge, path)
            try? fileManager.removeItem(at: target)
        }
        guard fileManager.fileExists(atPath: releaseRoot.appendingPathComponent("index.html").path) else {
            throw CodePushError(CodePushError.invalidPackage, "The update has no index.html after the diff.")
        }
        return releaseRoot
    }

    /// The single top-level folder holding `index.html`, else the unzipped folder itself when it holds one.
    private func findWebRoot(_ unzipped: URL) throws -> URL {
        let candidates = topLevelDirectories(unzipped)
            .map { unzipped.appendingPathComponent($0, isDirectory: true) }
            .filter { fileManager.fileExists(atPath: $0.appendingPathComponent("index.html").path) }
        if candidates.count == 1 { return candidates[0] }
        if fileManager.fileExists(atPath: unzipped.appendingPathComponent("index.html").path) { return unzipped }
        throw CodePushError(CodePushError.invalidPackage, "The update has no index.html.")
    }

    private func topLevelDirectories(_ folder: URL) -> [String] {
        ((try? fileManager.contentsOfDirectory(atPath: folder.path)) ?? []).filter { name in
            var isDirectory: ObjCBool = false
            return name != "__MACOSX"
                && fileManager.fileExists(atPath: folder.appendingPathComponent(name).path, isDirectory: &isDirectory)
                && isDirectory.boolValue
        }
    }
}
