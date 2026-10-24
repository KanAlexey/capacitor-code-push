import Foundation
import XCTest
import ZIPFoundation
@testable import CodePushCore

let binary = BinaryIdentity(versionName: "2.3.4", versionCode: "234", buildStamp: "1700000000000")

func metadata(_ hash: String, label: String? = nil, key: String = "key-1") -> PackageMetadata {
    PackageMetadata(deploymentKey: key, description: "update \(hash)", label: label ?? "v-\(hash)",
                    appVersion: binary.versionName, isMandatory: false, packageHash: hash, packageSize: 100)
}

/// A fresh folder per test, removed afterwards.
class TemporaryFolderTestCase: XCTestCase {
    var temporary: URL!

    override func setUpWithError() throws {
        temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporary)
    }

    func newFolder() throws -> URL {
        let folder = temporary.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// A zip holding `entries`, written with ZIPFoundation.
    func zip(_ entries: [String: String]) throws -> URL {
        let url = temporary.appendingPathComponent("\(UUID().uuidString).zip")
        let archive = try Archive(url: url, accessMode: .create)
        for (path, content) in entries.sorted(by: { $0.key < $1.key }) {
            let data = Data(content.utf8)
            try archive.addEntry(with: path, type: .file, uncompressedSize: Int64(data.count)) { position, size in
                data.subdata(in: Int(position)..<Int(position) + size)
            }
        }
        return url
    }

    func write(_ files: [String: String], under root: URL) throws {
        for (path, content) in files {
            let url = root.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(content.utf8).write(to: url)
        }
    }
}

extension StateStore {
    /// Puts a package straight into the store, as a finished download would.
    @discardableResult
    func stageFake(_ hash: String, label: String? = nil) throws -> PackageMetadata {
        let folder = try packageDir(hash)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("<title>\(hash)</title>".utf8).write(to: folder.appendingPathComponent("index.html"))
        let pkg = metadata(hash, label: label)
        try writeSidecar(pkg)
        return pkg
    }
}

/// Every file under `root`, by relative path.
func tree(_ root: URL) -> [String: String] {
    var result: [String: String] = [:]
    for relative in FileManager.default.subpaths(atPath: root.path) ?? [] {
        var isDirectory: ObjCBool = false
        let url = root.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue {
            result[relative] = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        }
    }
    return result
}

func XCTAssertThrowsCode(_ code: String, _ expression: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
    do {
        try expression()
        XCTFail("Expected \(code), nothing was thrown", file: file, line: line)
    } catch let error as CodePushError {
        XCTAssertEqual(error.code, code, error.message, file: file, line: line)
    } catch {
        XCTFail("Expected \(code), got \(error)", file: file, line: line)
    }
}
