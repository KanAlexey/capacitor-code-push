import Foundation

/// The plugin's folder: `state.json`, staged packages under `packages/` (a web root per hash plus a `<hash>.json`
/// sidecar), and `download/` as scratch.
public final class StateStore {
    public let root: URL
    public let packagesDir: URL
    public let downloadDir: URL
    private let stateFile: URL
    private let fileManager = FileManager.default

    public init(root: URL) {
        self.root = root
        packagesDir = root.appendingPathComponent("packages", isDirectory: true)
        downloadDir = root.appendingPathComponent("download", isDirectory: true)
        stateFile = root.appendingPathComponent("state.json")
    }

    public var exists: Bool { fileManager.fileExists(atPath: stateFile.path) }

    /// The stored state; an absent or unreadable file reads as empty, which serves the store bundle.
    public func read() -> CodePushState {
        guard let data = try? Data(contentsOf: stateFile) else { return CodePushState() }
        do {
            return try JSONDecoder().decode(CodePushState.self, from: data)
        } catch {
            CodePushLog.info("Unreadable state.json, starting from the store bundle: \(error)")
            return CodePushState()
        }
    }

    /// Written atomically, so a crash leaves the old state or the new one.
    public func write(_ state: CodePushState) throws {
        try createRoot()
        try JSONEncoder().encode(state).write(to: stateFile, options: .atomic)
    }

    public func packageDir(_ packageHash: String) throws -> URL {
        packagesDir.appendingPathComponent(try Self.checkedHash(packageHash), isDirectory: true)
    }

    private func sidecar(_ packageHash: String) throws -> URL {
        packagesDir.appendingPathComponent("\(try Self.checkedHash(packageHash)).json")
    }

    /// A staged package is usable when its web root still holds `index.html`.
    public func isStaged(_ packageHash: String) -> Bool {
        guard let folder = try? packageDir(packageHash), let sidecar = try? sidecar(packageHash) else { return false }
        return fileManager.fileExists(atPath: folder.appendingPathComponent("index.html").path)
            && fileManager.fileExists(atPath: sidecar.path)
    }

    public func readSidecar(_ packageHash: String) -> PackageMetadata? {
        guard let url = try? sidecar(packageHash), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(PackageMetadata.self, from: data)
    }

    public func writeSidecar(_ metadata: PackageMetadata) throws {
        try fileManager.createDirectory(at: packagesDir, withIntermediateDirectories: true)
        try JSONEncoder().encode(metadata).write(to: try sidecar(metadata.packageHash), options: .atomic)
    }

    public func deletePackage(_ packageHash: String) {
        if let folder = try? packageDir(packageHash) { try? fileManager.removeItem(at: folder) }
        if let file = try? sidecar(packageHash) { try? fileManager.removeItem(at: file) }
    }

    /// Deletes every staged package not named in `keep`.
    public func deletePackages(except keep: Set<String>) {
        let names = (try? fileManager.contentsOfDirectory(atPath: packagesDir.path)) ?? []
        for name in names where !keep.contains(name.hasSuffix(".json") ? String(name.dropLast(5)) : name) {
            try? fileManager.removeItem(at: packagesDir.appendingPathComponent(name))
        }
    }

    public func deleteAllPackages() {
        try? fileManager.removeItem(at: packagesDir)
    }

    /// Creates the folder, kept out of iCloud and iTunes backups: it holds nothing that cannot be downloaded again.
    private func createRoot() throws {
        guard !fileManager.fileExists(atPath: root.path) else { return }
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = root
        try? url.setResourceValues(values)
    }

    /// A package hash names a folder, so it must not be able to name anything else.
    public static func checkedHash(_ packageHash: String) throws -> String {
        let valid = !packageHash.isEmpty && packageHash.count <= 128
            && packageHash.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII
                || $0 == "_" || $0 == "-" }
        guard valid else {
            throw CodePushError(CodePushError.invalidArgument, "Invalid package hash: \(packageHash)")
        }
        return packageHash
    }
}
