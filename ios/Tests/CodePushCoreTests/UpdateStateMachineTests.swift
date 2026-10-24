import XCTest
@testable import CodePushCore

final class UpdateStateMachineTests: TemporaryFolderTestCase {
    var store: StateStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        store = StateStore(root: temporary.appendingPathComponent("capacitor-codepush", isDirectory: true))
    }

    /// A new process: a fresh machine over the same folder, as after the app was killed.
    @discardableResult
    func launch(_ identity: BinaryIdentity = binary, legacy: String? = nil) throws -> (UpdateStateMachine, String?) {
        let machine = UpdateStateMachine(store: store)
        return (machine, try machine.coldStart(binary: identity, legacyIdentifier: { legacy }))
    }

    func launchedAndConfirmed(_ hash: String, on machine: UpdateStateMachine) throws {
        try store.stageFake(hash)
        _ = try machine.install(packageHash: hash, installMode: InstallModes.immediate, minimumBackgroundDuration: 0)
        _ = try machine.applyPending()
        _ = try machine.notifyApplicationReady(appVersion: binary.versionName)
    }

    func testFirstLaunchServesTheStoreBundleAndRecordsTheBinary() throws {
        let (machine, served) = try launch()

        XCTAssertNil(served)
        XCTAssertNil(machine.currentPackage())
        XCTAssertEqual(store.read().binary, binary)
    }

    func testImmediateInstallIsLaunchedAtOnceAndIsAFirstRun() throws {
        let (machine, _) = try launch()
        try store.stageFake("q")

        XCTAssertTrue(try machine.install(packageHash: "q", installMode: InstallModes.immediate, minimumBackgroundDuration: 0))
        XCTAssertEqual(try machine.applyPending(), "q")

        XCTAssertEqual(machine.servedHash, "q")
        XCTAssertTrue(machine.didUpdate)
        XCTAssertEqual(machine.currentPackage()?.isFirstRun, true)
        XCTAssertEqual(store.read().pending?.isLoading, true)
    }

    func testOnNextRestartWaitsThenLaunchesAtTheNextColdStart() throws {
        let (machine, _) = try launch()
        try store.stageFake("q")

        XCTAssertFalse(try machine.install(packageHash: "q", installMode: InstallModes.onNextRestart, minimumBackgroundDuration: 0))
        XCTAssertNil(machine.servedHash)
        XCTAssertEqual(machine.pendingPackage()?.metadata.packageHash, "q")

        let (next, served) = try launch()
        XCTAssertEqual(served, "q")
        XCTAssertTrue(next.didUpdate)
        XCTAssertNil(next.pendingPackage())
        XCTAssertEqual(store.read().pending?.isLoading, true)
    }

    func testUnconfirmedLaunchIsRolledBackAndReported() throws {
        let (machine, _) = try launch()
        try store.stageFake("q")
        _ = try machine.install(packageHash: "q", installMode: InstallModes.immediate, minimumBackgroundDuration: 0)
        _ = try machine.applyPending()

        let (next, served) = try launch()

        XCTAssertNil(served)
        XCTAssertFalse(FileManager.default.fileExists(atPath: try store.packageDir("q").path))
        XCTAssertTrue(next.isFailed("q"))
        XCTAssertFalse(next.didUpdate)
        let report = try XCTUnwrap(try next.notifyApplicationReady(appVersion: binary.versionName))
        XCTAssertEqual(report.status, StatusReport.failed)
        XCTAssertEqual(report.package?.packageHash, "q")
        XCTAssertNil(store.read().rollbackReport)
    }

    func testRollbackReturnsToThePreviousConfirmedPackage() throws {
        let (machine, _) = try launch()
        try launchedAndConfirmed("p", on: machine)
        try store.stageFake("q")
        _ = try machine.install(packageHash: "q", installMode: InstallModes.onNextRestart, minimumBackgroundDuration: 0)

        try launch() // q launched
        let (_, served) = try launch() // q never confirmed

        XCTAssertEqual(served, "p")
        XCTAssertTrue(store.isStaged("p"))
        XCTAssertEqual(store.read().failedHashes, ["q"])
    }

    func testNotifyApplicationReadyConfirmsSoTheNextColdStartKeepsIt() throws {
        let (machine, _) = try launch()
        try launchedAndConfirmed("p", on: machine)
        try launchedAndConfirmed("q", on: machine)

        XCTAssertNil(store.read().pending)
        XCTAssertNil(store.read().previous)
        XCTAssertFalse(FileManager.default.fileExists(atPath: try store.packageDir("p").path))
        let (next, served) = try launch()
        XCTAssertEqual(served, "q")
        XCTAssertFalse(next.didUpdate)
        XCTAssertEqual(next.currentPackage()?.isFirstRun, false)
    }

    func testNotifyApplicationReadyLeavesAnUnlaunchedUpdateAlone() throws {
        let (machine, _) = try launch()
        try launchedAndConfirmed("p", on: machine)
        try store.stageFake("q")
        _ = try machine.install(packageHash: "q", installMode: InstallModes.onNextRestart, minimumBackgroundDuration: 0)

        _ = try machine.notifyApplicationReady(appVersion: binary.versionName)

        XCTAssertEqual(store.read().pending?.packageHash, "q")
        XCTAssertEqual(store.read().previous?.packageHash, "p")
        XCTAssertEqual(machine.currentPackage()?.metadata.packageHash, "p")
    }

    func testSecondInstallBeforeRestartReplacesTheFirstAndKeepsTheLastGoodPackage() throws {
        let (machine, _) = try launch()
        try launchedAndConfirmed("p", on: machine)
        try store.stageFake("q")
        try store.stageFake("r")

        _ = try machine.install(packageHash: "q", installMode: InstallModes.onNextRestart, minimumBackgroundDuration: 0)
        _ = try machine.install(packageHash: "r", installMode: InstallModes.onNextRestart, minimumBackgroundDuration: 0)

        XCTAssertEqual(store.read().current?.packageHash, "r")
        XCTAssertEqual(store.read().previous?.packageHash, "p")
        XCTAssertFalse(FileManager.default.fileExists(atPath: try store.packageDir("q").path))
    }

    func testInstallOverARunningUnconfirmedPackageKeepsTheServedFolder() throws {
        let (machine, _) = try launch()
        try store.stageFake("q")
        _ = try machine.install(packageHash: "q", installMode: InstallModes.immediate, minimumBackgroundDuration: 0)
        _ = try machine.applyPending()
        try store.stageFake("r")

        _ = try machine.install(packageHash: "r", installMode: InstallModes.onNextRestart, minimumBackgroundDuration: 0)

        XCTAssertTrue(store.isStaged("q"))
        let (_, served) = try launch()
        XCTAssertEqual(served, "r")
        XCTAssertFalse(FileManager.default.fileExists(atPath: try store.packageDir("q").path))
    }

    func testNewBinaryDeletesPackagesAndKeepsTelemetry() throws {
        let (machine, _) = try launch()
        try store.stageFake("q")
        _ = try machine.install(packageHash: "q", installMode: InstallModes.immediate, minimumBackgroundDuration: 0)
        _ = try machine.applyPending()
        try machine.recordStatusReported(try XCTUnwrap(Telemetry.updateReport(metadata("q"), lastReportedIdentifier: nil)))
        _ = try machine.notifyApplicationReady(appVersion: binary.versionName)

        var newBinary = binary
        newBinary.buildStamp = "1800000000000"
        let (next, served) = try launch(newBinary)

        XCTAssertNil(served)
        XCTAssertTrue((FileManager.default.subpaths(atPath: store.packagesDir.path) ?? []).isEmpty)
        XCTAssertNil(store.read().current)
        XCTAssertEqual(store.read().lastReportedIdentifier, "key-1:v-q")
        let report = try XCTUnwrap(try next.notifyApplicationReady(appVersion: binary.versionName))
        XCTAssertEqual(report.appVersion, binary.versionName)
        XCTAssertEqual(report.previousLabelOrAppVersion, "v-q")
        XCTAssertEqual(report.previousDeploymentKey, "key-1")
    }

    func testOnNextResumeAppliesOnlyAfterTheMinimumTimeAway() throws {
        let (machine, _) = try launch()
        try store.stageFake("q")
        _ = try machine.install(packageHash: "q", installMode: InstallModes.onNextResume, minimumBackgroundDuration: 30)

        XCTAssertNil(try machine.onResume(secondsInBackground: 29))
        XCTAssertEqual(try machine.onResume(secondsInBackground: 30), "q")
        XCTAssertNil(try machine.onResume(secondsInBackground: 60))
    }

    func testOnNextRestartDoesNotApplyOnResume() throws {
        let (machine, _) = try launch()
        try store.stageFake("q")
        _ = try machine.install(packageHash: "q", installMode: InstallModes.onNextRestart, minimumBackgroundDuration: 0)

        XCTAssertNil(try machine.onResume(secondsInBackground: 3600))
    }

    func testRestartAppliesAPendingUpdateOrReloadsOrDoesNothing() throws {
        let (machine, _) = try launch()
        XCTAssertEqual(try machine.restart(onlyIfUpdateIsPending: false), RestartDecision(reload: true, servedHash: nil))
        XCTAssertEqual(try machine.restart(onlyIfUpdateIsPending: true), RestartDecision(reload: false, servedHash: nil))

        try store.stageFake("q")
        _ = try machine.install(packageHash: "q", installMode: InstallModes.onNextRestart, minimumBackgroundDuration: 0)

        XCTAssertEqual(try machine.restart(onlyIfUpdateIsPending: true), RestartDecision(reload: true, servedHash: "q"))
    }

    func testAPackageWhoseFilesDisappearedIsNotServed() throws {
        let (machine, _) = try launch()
        try launchedAndConfirmed("q", on: machine)
        try FileManager.default.removeItem(at: try store.packageDir("q").appendingPathComponent("index.html"))

        let (next, served) = try launch()

        XCTAssertNil(served)
        XCTAssertNil(next.currentPackage())
    }

    func testInstallRefusesAPackageThatWasNotDownloaded() throws {
        let (machine, _) = try launch()

        XCTAssertThrowsCode(CodePushError.notStaged) {
            _ = try machine.install(packageHash: "nothing", installMode: InstallModes.immediate, minimumBackgroundDuration: 0)
        }
    }

    func testAnUnreadableStateFileReadsAsTheStoreBundle() throws {
        try FileManager.default.createDirectory(at: store.root, withIntermediateDirectories: true)
        try Data("{not json".utf8).write(to: store.root.appendingPathComponent("state.json"))

        let (_, served) = try launch()

        XCTAssertNil(served)
    }

    func testAColdStartCollectsFoldersNothingNames() throws {
        try launch()
        try store.stageFake("stray")

        try launch()

        XCTAssertFalse(FileManager.default.fileExists(atPath: try store.packageDir("stray").path))
    }

    func testTheLegacyIdentifierIsReadOnlyWhenNoStateExists() throws {
        try launch(legacy: "key-1:v3")
        XCTAssertEqual(store.read().lastReportedIdentifier, "key-1:v3")

        try launch(legacy: "other")
        XCTAssertEqual(store.read().lastReportedIdentifier, "key-1:v3")
    }

    func testStoreBundleReportIsSentOnceAndRetriedWhenItFailed() throws {
        let (machine, _) = try launch()

        let first = try XCTUnwrap(try machine.notifyApplicationReady(appVersion: binary.versionName))
        XCTAssertEqual(first, StatusReport(appVersion: binary.versionName))
        try machine.saveStatusReportForRetry(first)
        XCTAssertEqual(try machine.notifyApplicationReady(appVersion: binary.versionName), first)
        try machine.recordStatusReported(first)

        XCTAssertNil(try machine.notifyApplicationReady(appVersion: binary.versionName))
        XCTAssertNil(store.read().retryReport)
    }

    func testALaunchedPackageIsReportedOnceTheServerTookIt() throws {
        let (machine, _) = try launch()
        try machine.recordStatusReported(try XCTUnwrap(try machine.notifyApplicationReady(appVersion: binary.versionName)))
        try store.stageFake("q", label: "v9")
        _ = try machine.install(packageHash: "q", installMode: InstallModes.immediate, minimumBackgroundDuration: 0)
        _ = try machine.applyPending()

        let report = try XCTUnwrap(try machine.notifyApplicationReady(appVersion: binary.versionName))
        XCTAssertEqual(report.status, StatusReport.succeeded)
        XCTAssertEqual(report.package?.label, "v9")
        XCTAssertEqual(report.previousLabelOrAppVersion, binary.versionName)
        XCTAssertNil(report.previousDeploymentKey)

        try machine.recordStatusReported(report)
        XCTAssertNil(try machine.notifyApplicationReady(appVersion: binary.versionName))
    }
}
