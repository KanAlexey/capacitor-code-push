import Foundation

/// A package as JavaScript sees it: its metadata plus what this device knows about it.
public struct PackageView: Equatable {
    public let metadata: PackageMetadata
    public let isFirstRun: Bool
    public let failedInstall: Bool

    public init(metadata: PackageMetadata, isFirstRun: Bool, failedInstall: Bool) {
        self.metadata = metadata
        self.isFirstRun = isFirstRun
        self.failedInstall = failedInstall
    }

    public var dictionary: [String: Any] {
        var result = metadata.dictionary
        result["isFirstRun"] = isFirstRun
        result["failedInstall"] = failedInstall
        return result
    }
}

/// Whether `restartApplication` reloads, and what it serves when it does (nil = the store bundle).
public struct RestartDecision: Equatable {
    public let reload: Bool
    public let servedHash: String?
}

/// The install and rollback state machine (DESIGN.md §8). It decides which package is served and keeps
/// `state.json` in step; the plugin only carries its decisions out. `pending.isLoading` is the crash detector: it is
/// set when a package is launched and cleared by `notifyApplicationReady`, so finding it set at a cold start means
/// the package never confirmed.
///
/// One instance lives for the whole process, so `didUpdate` and `servedHash` survive the bridge being recreated.
public final class UpdateStateMachine {
    private let store: StateStore
    private let lock = NSRecursiveLock()
    private var state = CodePushState()

    /// A package was launched by this process (react-native-code-push's `didUpdate`).
    public private(set) var didUpdate = false

    /// What the web view serves; nil is the store bundle.
    public private(set) var servedHash: String?

    public init(store: StateStore) {
        self.store = store
    }

    /// Decides what a cold start serves. `legacyIdentifier` is read only when no state exists yet, to carry the last
    /// report of cordova-plugin-code-push over.
    @discardableResult
    public func coldStart(binary: BinaryIdentity, legacyIdentifier: () -> String? = { nil }) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        var s = store.exists ? store.read() : CodePushState(lastReportedIdentifier: legacyIdentifier())
        if s.binary != binary {
            if s.binary != nil {
                CodePushLog.info("New binary \(binary.versionName) (\(binary.versionCode)): back to the store bundle.")
            }
            store.deleteAllPackages()
            s = CodePushState(binary: binary, lastReportedIdentifier: s.lastReportedIdentifier, retryReport: s.retryReport)
        }

        if let pending = s.pending {
            if pending.packageHash != s.current?.packageHash {
                s.pending = nil
            } else if pending.isLoading {
                CodePushLog.info("Package \(pending.packageHash) did not confirm its last launch: rolling back.")
                s = rollback(s)
            } else {
                s.pending?.isLoading = true
                didUpdate = true
            }
        }

        s = fallBackFromMissing(s)
        servedHash = s.current?.packageHash
        state = s
        store.deletePackages(except: Set([s.current?.packageHash, s.previous?.packageHash].compactMap { $0 }))
        try store.write(s)
        return servedHash
    }

    /// Installs a staged package. True when it is to be applied now (`IMMEDIATE`).
    public func install(packageHash: String, installMode: Int, minimumBackgroundDuration: Int) throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard store.isStaged(packageHash), let metadata = store.readSidecar(packageHash) else {
            throw CodePushError(CodePushError.notStaged, "Package \(packageHash) is not downloaded.")
        }
        let newPending = PendingUpdate(packageHash: packageHash, installMode: installMode,
                                       minimumBackgroundDuration: minimumBackgroundDuration, isLoading: false)
        var s = state
        if s.current?.packageHash == packageHash {
            guard let pending = s.pending, !pending.isLoading else { return false }
            s.pending = newPending
        } else if s.pending != nil {
            // An unconfirmed package is superseded; `previous` stays the last good one.
            let superseded = s.current
            s.current = metadata
            s.pending = newPending
            if let superseded, superseded.packageHash != servedHash {
                store.deletePackage(superseded.packageHash)
            }
        } else {
            let dropped = s.previous
            s.previous = s.current
            s.current = metadata
            s.pending = newPending
            if let dropped, dropped.packageHash != servedHash, dropped.packageHash != packageHash {
                store.deletePackage(dropped.packageHash)
            }
        }
        try commit(s)
        return installMode == InstallModes.immediate
    }

    /// Launches the pending package now. Returns its hash, or nil when there is nothing to launch.
    public func applyPending() throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard let pending = state.pending, !pending.isLoading else { return nil }
        guard store.isStaged(pending.packageHash) else {
            CodePushLog.info("Pending package \(pending.packageHash) is gone: dropping it.")
            var s = state
            s.current = s.previous
            s.previous = nil
            s.pending = nil
            try commit(s)
            return nil
        }
        var s = state
        s.pending?.isLoading = true
        try commit(s)
        didUpdate = true
        servedHash = pending.packageHash
        return servedHash
    }

    /// On a resume: launches an `ON_NEXT_RESUME` package once the app was away long enough.
    public func onResume(secondsInBackground: Int) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard let pending = state.pending, !pending.isLoading,
              pending.installMode == InstallModes.onNextResume,
              secondsInBackground >= pending.minimumBackgroundDuration else { return nil }
        return try applyPending()
    }

    public func restart(onlyIfUpdateIsPending: Bool) throws -> RestartDecision {
        lock.lock()
        defer { lock.unlock() }
        if pendingPackage() != nil, let launched = try applyPending() {
            return RestartDecision(reload: true, servedHash: launched)
        }
        return RestartDecision(reload: !onlyIfUpdateIsPending, servedHash: servedHash)
    }

    /// Confirms a launched package and returns the report that is due, if any.
    public func notifyApplicationReady(appVersion: String) throws -> StatusReport? {
        lock.lock()
        defer { lock.unlock() }
        var s = state
        if s.pending?.isLoading == true {
            let previous = s.previous
            s.pending = nil
            s.previous = nil
            if let previous, previous.packageHash != servedHash {
                store.deletePackage(previous.packageHash)
            }
        }

        var report: StatusReport?
        if let rollback = s.rollbackReport {
            report = Telemetry.rollbackReport(rollback)
            s.rollbackReport = nil
        } else if didUpdate, let current = s.current, servedHash == current.packageHash {
            report = Telemetry.updateReport(current, lastReportedIdentifier: s.lastReportedIdentifier)
        } else if servedHash == nil {
            report = Telemetry.binaryReport(appVersion, lastReportedIdentifier: s.lastReportedIdentifier)
        }
        if report == nil, let retry = s.retryReport {
            report = retry
            s.retryReport = nil
        }
        try commit(s)
        return report
    }

    public func recordStatusReported(_ report: StatusReport) throws {
        lock.lock()
        defer { lock.unlock() }
        var s = state
        if let identifier = Telemetry.identifier(after: report) {
            s.lastReportedIdentifier = identifier
        }
        if s.retryReport == report {
            s.retryReport = nil
        }
        try commit(s)
    }

    public func saveStatusReportForRetry(_ report: StatusReport) throws {
        lock.lock()
        defer { lock.unlock() }
        var s = state
        s.retryReport = report
        try commit(s)
    }

    /// The package being served, or nil for the store bundle.
    public func currentPackage() -> PackageView? {
        lock.lock()
        defer { lock.unlock() }
        guard let hash = servedHash else { return nil }
        let metadata = [state.current, state.previous].compactMap { $0 }.first { $0.packageHash == hash }
            ?? store.readSidecar(hash)
        return metadata.map(view)
    }

    /// An installed package waiting for a restart or a resume.
    public func pendingPackage() -> PackageView? {
        lock.lock()
        defer { lock.unlock() }
        guard let pending = state.pending, !pending.isLoading,
              let current = state.current, current.packageHash == pending.packageHash else { return nil }
        return view(current)
    }

    public func isFailed(_ packageHash: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return state.failedHashes.contains(packageHash)
    }

    /// The package a diff is applied on: the latest installed one, or nil for the store bundle.
    public func diffBase() -> PackageMetadata? {
        lock.lock()
        defer { lock.unlock() }
        return state.current
    }

    /// True for a package a new download must not overwrite, because it is served or kept to fall back to.
    public func isInUse(_ packageHash: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return [servedHash, state.current?.packageHash, state.previous?.packageHash].contains(packageHash)
    }

    public func cachedBinaryHash() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return state.binaryHash
    }

    public func saveBinaryHash(_ hash: String) throws {
        lock.lock()
        defer { lock.unlock() }
        var s = state
        s.binaryHash = hash
        try commit(s)
    }

    private func view(_ metadata: PackageMetadata) -> PackageView {
        PackageView(
            metadata: metadata,
            isFirstRun: didUpdate && metadata.packageHash == state.current?.packageHash && metadata.packageHash == servedHash,
            failedInstall: state.failedHashes.contains(metadata.packageHash))
    }

    private func rollback(_ start: CodePushState) -> CodePushState {
        var s = start
        guard let failed = s.current else {
            s.pending = nil
            return s
        }
        store.deletePackage(failed.packageHash)
        s.current = s.previous
        s.previous = nil
        s.pending = nil
        if !s.failedHashes.contains(failed.packageHash) {
            s.failedHashes.append(failed.packageHash)
        }
        s.rollbackReport = failed
        return s
    }

    /// A package whose files are gone cannot be served; step back to one that can, ending at the store bundle.
    private func fallBackFromMissing(_ start: CodePushState) -> CodePushState {
        var s = start
        while let current = s.current, !store.isStaged(current.packageHash) {
            CodePushLog.info("Package \(current.packageHash) is missing its files: falling back.")
            s.current = s.previous
            s.previous = nil
            s.pending = nil
            didUpdate = false
        }
        if let previous = s.previous, !store.isStaged(previous.packageHash) {
            s.previous = nil
        }
        return s
    }

    private func commit(_ s: CodePushState) throws {
        state = s
        try store.write(s)
    }
}
