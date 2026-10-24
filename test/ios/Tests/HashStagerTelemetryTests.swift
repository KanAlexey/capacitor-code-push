import XCTest
@testable import CodePushCore

/// The repository's `test/fixtures/hash`, shared with the TypeScript and Kotlin suites.
private let fixture = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // Tests
    .deletingLastPathComponent() // ios
    .deletingLastPathComponent() // test
    .appendingPathComponent("fixtures/hash", isDirectory: true)

final class PackageHasherTests: XCTestCase {
    func testTheSharedFixtureHashesToTheValueTheRevopushCLIComputes() throws {
        let expected = try JSONSerialization.jsonObject(
            with: Data(contentsOf: fixture.appendingPathComponent("expected.json"))) as? [String: Any]
        let releaseRoot = fixture.appendingPathComponent("release/www", isDirectory: true)

        XCTAssertEqual(try PackageHasher.hash(directory: releaseRoot, prefix: "www"), expected?["packageHash"] as? String)
    }

    func testStringsAreQuotedExactlyAsJSONStringifyQuotesThem() {
        let values = ["plain", "a\"b", "c\\d", "tab\there", "\u{01}", "/slash/", "ünï", "😀"]

        XCTAssertEqual(
            PackageHasher.jsonStringify(values),
            "[\"plain\",\"a\\\"b\",\"c\\\\d\",\"tab\\there\",\"\\u0001\",\"/slash/\",\"ünï\",\"😀\"]")
    }

    func testTheIgnoreRulesAreTheCLIs() {
        XCTAssertTrue(PackageHasher.isIgnored(".DS_Store"))
        XCTAssertTrue(PackageHasher.isIgnored("www/a/.DS_Store"))
        XCTAssertTrue(PackageHasher.isIgnored("__MACOSX/x"))
        XCTAssertFalse(PackageHasher.isIgnored("www/__MACOSX/x"))
        XCTAssertFalse(PackageHasher.isIgnored("www/.codepushrelease"))
    }
}

final class TelemetryTests: XCTestCase {
    func testAnUpdateReportNamesThePreviousPackageByKeyAndLabel() throws {
        let report = try XCTUnwrap(Telemetry.updateReport(metadata("q", label: "v9", key: "k2"), lastReportedIdentifier: "k1:v8"))

        XCTAssertEqual(report.status, StatusReport.succeeded)
        XCTAssertEqual(report.previousLabelOrAppVersion, "v8")
        XCTAssertEqual(report.previousDeploymentKey, "k1")
        XCTAssertNil(Telemetry.updateReport(metadata("q", label: "v9", key: "k2"), lastReportedIdentifier: "k2:v9"))
    }

    func testABinaryReportNamesThePreviousAppVersion() {
        XCTAssertEqual(Telemetry.binaryReport("2.0.0", lastReportedIdentifier: nil), StatusReport(appVersion: "2.0.0"))
        XCTAssertEqual(Telemetry.binaryReport("2.0.0", lastReportedIdentifier: "1.9.0"),
                       StatusReport(appVersion: "2.0.0", previousLabelOrAppVersion: "1.9.0"))
        XCTAssertNil(Telemetry.binaryReport("2.0.0", lastReportedIdentifier: "2.0.0"))
    }

    func testOnlyASuccessfulReportMovesTheIdentifier() {
        XCTAssertEqual(Telemetry.identifier(after: StatusReport(status: StatusReport.succeeded, package: metadata("q"))), "key-1:v-q")
        XCTAssertEqual(Telemetry.identifier(after: StatusReport(appVersion: "2.0.0")), "2.0.0")
        XCTAssertNil(Telemetry.identifier(after: Telemetry.rollbackReport(metadata("q"))))
    }

    func testCordovaPluginLastVersionMapsOntoAnIdentifier() {
        XCTAssertEqual(Telemetry.identifierFromLegacy(labelOrAppVersion: "v12", deploymentKey: "k1"), "k1:v12")
        XCTAssertEqual(Telemetry.identifierFromLegacy(labelOrAppVersion: "9.9.601", deploymentKey: "k1"), "9.9.601")
        XCTAssertNil(Telemetry.identifierFromLegacy(labelOrAppVersion: nil, deploymentKey: "k1"))
    }

    func testAStatusReportSurvivesTheBridgeDictionary() {
        let report = StatusReport(status: StatusReport.failed, package: metadata("q"),
                                  previousLabelOrAppVersion: "v1", previousDeploymentKey: "k")

        XCTAssertEqual(StatusReport(dictionary: report.dictionary), report)
    }
}

final class PackageStagerTests: TemporaryFolderTestCase {
    var store: StateStore!
    var stager: PackageStager!
    let noBase: BaseSource = { _ in XCTFail("a full package needs no base") }

    override func setUpWithError() throws {
        try super.setUpWithError()
        store = StateStore(root: temporary.appendingPathComponent("capacitor-codepush", isDirectory: true))
        stager = PackageStager(store: store)
    }

    /// The hash a release of `files`, under a folder named `folder`, has on the server.
    func releaseHash(_ files: [String: String], folder: String = "www") throws -> String {
        let root = try newFolder().appendingPathComponent(folder, isDirectory: true)
        try write(files, under: root)
        return try PackageHasher.hash(directory: root, prefix: folder)
    }

    func testAFullReleaseOfAWwwFolderIsStagedWithIndexAtThePackageRoot() throws {
        try stager.stage(zip: try zip(["www/index.html": "i", "www/js/main.js": "m"]), metadata: metadata("h1"),
                         base: noBase, publicKeyConfigured: false)

        XCTAssertEqual(tree(try store.packageDir("h1")), ["index.html": "i", "js/main.js": "m"])
        XCTAssertEqual(store.readSidecar("h1"), metadata("h1"))
        XCTAssertTrue(store.isStaged("h1"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.downloadDir.path))
    }

    func testAZipWithIndexAtItsRootIsStagedAsItIs() throws {
        try stager.stage(zip: try zip(["index.html": "i"]), metadata: metadata("h1"), base: noBase, publicKeyConfigured: false)

        XCTAssertEqual(tree(try store.packageDir("h1")), ["index.html": "i"])
    }

    func testAFullReleaseIsNotHashed() throws {
        try stager.stage(zip: try zip(["www/index.html": "i"]), metadata: metadata("not-its-hash"), base: noBase,
                         publicKeyConfigured: false)

        XCTAssertTrue(store.isStaged("not-its-hash"))
    }

    func testAReleaseWithoutIndexIsRefused() throws {
        let archive = try zip(["www/main.js": "m"])
        XCTAssertThrowsCode(CodePushError.invalidPackage) {
            try self.stager.stage(zip: archive, metadata: metadata("h1"), base: self.noBase, publicKeyConfigured: false)
        }
        XCTAssertFalse(store.isStaged("h1"))
    }

    func testPathsOutsideTheFolderAreRefused() {
        for path in ["../evil.js", "www/../../evil.js", "/etc/passwd", "C:/Windows/x"] {
            XCTAssertThrowsCode(CodePushError.invalidPackage) { _ = try Unzipper.resolveInside(self.temporary, path) }
        }
    }

    func testAConfiguredPublicKeyRefusesEveryPackage() throws {
        let archive = try zip(["www/index.html": "i"])
        XCTAssertThrowsCode(CodePushError.signatureUnsupported) {
            try self.stager.stage(zip: archive, metadata: metadata("h1"), base: self.noBase, publicKeyConfigured: true)
        }
    }

    func testADiffIsLaidOverItsBaseDeletesWhatItListsAndMustMatchTheHash() throws {
        let base: BaseSource = { destination in
            try self.write(["index.html": "old index", "js/keep.js": "keep", "js/old.js": "old"], under: destination)
        }
        let expected = ["index.html": "new index", "js/keep.js": "keep", "js/new.js": "new"]
        let hash = try releaseHash(expected)

        try stager.stage(
            zip: try zip([
                "www/index.html": "new index",
                "www/js/new.js": "new",
                "hotcodepush.json": #"{"deletedFiles":["www/js/old.js"]}"#
            ]),
            metadata: metadata(hash), base: base, publicKeyConfigured: false)

        XCTAssertEqual(tree(try store.packageDir(hash)), expected)
    }

    func testADiffThatOnlyDeletesStillLandsInAWwwFolder() throws {
        let base: BaseSource = { destination in try self.write(["index.html": "i", "gone.js": "g"], under: destination) }
        let hash = try releaseHash(["index.html": "i"])

        try stager.stage(zip: try zip(["hotcodepush.json": #"{"deletedFiles":["www/gone.js"]}"#]),
                         metadata: metadata(hash), base: base, publicKeyConfigured: false)

        XCTAssertEqual(tree(try store.packageDir(hash)), ["index.html": "i"])
    }

    func testADiffWhoseResultDoesNotMatchIsRefusedAndNotStaged() throws {
        let base: BaseSource = { destination in try self.write(["index.html": "i"], under: destination) }
        let archive = try zip(["www/a.js": "a", "hotcodepush.json": #"{"deletedFiles":[]}"#])

        XCTAssertThrowsCode(CodePushError.hashMismatch) {
            try self.stager.stage(zip: archive, metadata: metadata("wrong"), base: base, publicKeyConfigured: false)
        }
        XCTAssertFalse(store.isStaged("wrong"))
    }

    func testADiffDeletingOutsideItsFolderIsRefused() throws {
        let base: BaseSource = { destination in try self.write(["index.html": "i"], under: destination) }
        let archive = try zip(["hotcodepush.json": #"{"deletedFiles":["../../state.json"]}"#])

        XCTAssertThrowsCode(CodePushError.invalidPackage) {
            try self.stager.stage(zip: archive, metadata: metadata("h1"), base: base, publicKeyConfigured: false)
        }
    }

    func testAHashThatCouldNameAnotherFolderIsRefused() throws {
        let archive = try zip(["www/index.html": "i"])
        XCTAssertThrowsCode(CodePushError.invalidArgument) {
            try self.stager.stage(zip: archive, metadata: metadata("../escape"), base: self.noBase, publicKeyConfigured: false)
        }
    }
}
