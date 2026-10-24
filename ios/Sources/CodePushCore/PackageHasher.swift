import CryptoKit
import Foundation

/// The package hash as the Revopush CLI and server compute it (DESIGN.md §11): every file as
/// `<prefix>/<path>:<sha256>`, skipping `.DS_Store` anywhere and a leading `__MACOSX/`, sorted by UTF-16 code unit,
/// then the sha256 of their `JSON.stringify`. The store bundle is a folder on iOS too, so one walker serves both.
public enum PackageHasher {
    public static func hash(directory root: URL, prefix: String) throws -> String {
        let fileManager = FileManager.default
        guard let paths = fileManager.subpaths(atPath: root.path) else {
            throw CodePushError(CodePushError.invalidPackage, "Cannot read \(root.path)")
        }
        var entries: [String] = []
        for relative in paths {
            var isDirectory: ObjCBool = false
            let url = root.appendingPathComponent(relative)
            guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                continue
            }
            let path = prefix.isEmpty ? relative : "\(prefix)/\(relative)"
            if isIgnored(path) { continue }
            entries.append("\(path):\(try sha256(file: url))")
        }
        entries.sort { $0.utf16.lexicographicallyPrecedes($1.utf16) }
        return hex(SHA256.hash(data: Data(jsonStringify(entries).utf8)))
    }

    public static func isIgnored(_ relativePath: String) -> Bool {
        relativePath.hasPrefix("__MACOSX/") || relativePath == ".DS_Store" || relativePath.hasSuffix("/.DS_Store")
    }

    /// `JSON.stringify` of an array of strings, byte for byte.
    public static func jsonStringify(_ values: [String]) -> String {
        "[" + values.map(quote).joined(separator: ",") + "]"
    }

    private static func quote(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case let control where control.value < 0x20: out += String(format: "\\u%04x", control.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }

    public static func sha256(file url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hex(hasher.finalize())
    }

    private static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}
