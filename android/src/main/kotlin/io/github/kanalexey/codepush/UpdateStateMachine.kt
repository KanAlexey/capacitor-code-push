package io.github.kanalexey.codepush

/** A package as JavaScript sees it: its metadata plus what this device knows about it. */
data class PackageView(val metadata: PackageMetadata, val isFirstRun: Boolean, val failedInstall: Boolean)

/** Whether `restartApplication` reloads, and what it serves when it does (null = the store bundle). */
data class RestartDecision(val reload: Boolean, val servedHash: String?)

/**
 * The install and rollback state machine (DESIGN.md §8). It decides which package is served and keeps
 * `state.json` in step; the plugin only carries its decisions out. `pending.isLoading` is the crash detector: it is
 * set when a package is launched and cleared by [notifyApplicationReady], so finding it set at a cold start means
 * the package never confirmed.
 *
 * One instance lives for the whole process, so [didUpdate] and [servedHash] survive the bridge being recreated.
 */
class UpdateStateMachine(private val store: StateStore) {
    private var state = CodePushState()

    /** A package was launched by this process (react-native-code-push's `didUpdate`). */
    var didUpdate = false
        private set

    /** What the web view serves; null is the store bundle. */
    var servedHash: String? = null
        private set

    /**
     * Decides what a cold start serves. [legacyIdentifier] is read only when no state exists yet, to carry the
     * last report of cordova-plugin-code-push over.
     */
    @Synchronized
    fun coldStart(binary: BinaryIdentity, legacyIdentifier: () -> String? = { null }): String? {
        var s = if (store.exists()) store.read() else CodePushState(lastReportedIdentifier = legacyIdentifier())
        if (s.binary != binary) {
            if (s.binary != null) {
                Log.info("New binary ${binary.versionName} (${binary.versionCode}): back to the store bundle.")
            }
            store.deleteAllPackages()
            s = CodePushState(
                binary = binary,
                lastReportedIdentifier = s.lastReportedIdentifier,
                retryReport = s.retryReport,
            )
        }

        val pending = s.pending
        if (pending != null && pending.packageHash != s.current?.packageHash) {
            s = s.copy(pending = null)
        } else if (pending != null && pending.isLoading) {
            Log.warn("Package ${pending.packageHash} did not confirm its last launch: rolling back.")
            s = rollback(s)
        } else if (pending != null) {
            s = s.copy(pending = pending.copy(isLoading = true))
            didUpdate = true
        }

        s = fallBackFromMissing(s)
        servedHash = s.current?.packageHash
        state = s
        store.deletePackagesExcept(setOfNotNull(s.current?.packageHash, s.previous?.packageHash))
        store.write(s)
        return servedHash
    }

    /** Installs a staged package. True when it is to be applied now (`IMMEDIATE`). */
    @Synchronized
    fun install(packageHash: String, installMode: Int, minimumBackgroundDuration: Int): Boolean {
        if (!store.isStaged(packageHash)) {
            throw CodePushException(CodePushException.NOT_STAGED, "Package $packageHash is not downloaded.")
        }
        val metadata = store.readSidecar(packageHash)
            ?: throw CodePushException(CodePushException.NOT_STAGED, "Package $packageHash has no metadata.")
        val newPending = PendingUpdate(packageHash, installMode, minimumBackgroundDuration, isLoading = false)
        var s = state
        val pending = s.pending

        if (s.current?.packageHash == packageHash) {
            if (pending == null || pending.isLoading) {
                return false
            }
            s = s.copy(pending = newPending)
        } else if (pending != null) {
            // An unconfirmed package is superseded; `previous` stays the last good one.
            val superseded = s.current
            s = s.copy(current = metadata, pending = newPending)
            if (superseded != null && superseded.packageHash != servedHash) {
                store.deletePackage(superseded.packageHash)
            }
        } else {
            val dropped = s.previous
            s = s.copy(previous = s.current, current = metadata, pending = newPending)
            if (dropped != null && dropped.packageHash != servedHash && dropped.packageHash != packageHash) {
                store.deletePackage(dropped.packageHash)
            }
        }
        commit(s)
        return installMode == InstallModes.IMMEDIATE
    }

    /** Launches the pending package now. Returns its hash, or null when there is nothing to launch. */
    @Synchronized
    fun applyPending(): String? {
        val pending = state.pending ?: return null
        if (pending.isLoading) {
            return null
        }
        if (!store.isStaged(pending.packageHash)) {
            Log.warn("Pending package ${pending.packageHash} is gone: dropping it.")
            commit(state.copy(current = state.previous, previous = null, pending = null))
            return null
        }
        commit(state.copy(pending = pending.copy(isLoading = true)))
        didUpdate = true
        servedHash = pending.packageHash
        return servedHash
    }

    /** On a resume: launches an `ON_NEXT_RESUME` package once the app was away long enough. */
    @Synchronized
    fun onResume(secondsInBackground: Long): String? {
        val pending = state.pending ?: return null
        if (pending.isLoading || pending.installMode != InstallModes.ON_NEXT_RESUME) {
            return null
        }
        return if (secondsInBackground >= pending.minimumBackgroundDuration) applyPending() else null
    }

    @Synchronized
    fun restart(onlyIfUpdateIsPending: Boolean): RestartDecision {
        if (pendingPackage() != null) {
            val launched = applyPending()
            if (launched != null) {
                return RestartDecision(reload = true, servedHash = launched)
            }
        }
        return RestartDecision(reload = !onlyIfUpdateIsPending, servedHash = servedHash)
    }

    /** Confirms a launched package and returns the report that is due, if any. */
    @Synchronized
    fun notifyApplicationReady(appVersion: String): StatusReport? {
        var s = state
        if (s.pending?.isLoading == true) {
            val previous = s.previous
            s = s.copy(pending = null, previous = null)
            if (previous != null && previous.packageHash != servedHash) {
                store.deletePackage(previous.packageHash)
            }
        }

        val current = s.current
        var report: StatusReport? = null
        if (s.rollbackReport != null) {
            report = Telemetry.rollbackReport(s.rollbackReport!!)
            s = s.copy(rollbackReport = null)
        } else if (didUpdate && current != null && servedHash == current.packageHash) {
            report = Telemetry.updateReport(current, s.lastReportedIdentifier)
        } else if (servedHash == null) {
            report = Telemetry.binaryReport(appVersion, s.lastReportedIdentifier)
        }
        if (report == null && s.retryReport != null) {
            report = s.retryReport
            s = s.copy(retryReport = null)
        }
        commit(s)
        return report
    }

    @Synchronized
    fun recordStatusReported(report: StatusReport) {
        var s = state
        Telemetry.identifierAfter(report)?.let { s = s.copy(lastReportedIdentifier = it) }
        if (s.retryReport == report) {
            s = s.copy(retryReport = null)
        }
        commit(s)
    }

    @Synchronized
    fun saveStatusReportForRetry(report: StatusReport) {
        commit(state.copy(retryReport = report))
    }

    /** The package being served, or null for the store bundle. */
    @Synchronized
    fun currentPackage(): PackageView? {
        val hash = servedHash ?: return null
        val metadata = listOfNotNull(state.current, state.previous).firstOrNull { it.packageHash == hash }
            ?: store.readSidecar(hash)
            ?: return null
        return view(metadata)
    }

    /** An installed package waiting for a restart or a resume. */
    @Synchronized
    fun pendingPackage(): PackageView? {
        val pending = state.pending ?: return null
        if (pending.isLoading) {
            return null
        }
        return state.current?.takeIf { it.packageHash == pending.packageHash }?.let { view(it) }
    }

    @Synchronized
    fun isFailed(packageHash: String): Boolean = packageHash in state.failedHashes

    /** The package a diff is applied on: the latest installed one, or null for the store bundle. */
    @Synchronized
    fun diffBase(): PackageMetadata? = state.current

    /** True for a package a new download must not overwrite, because it is served or kept to fall back to. */
    @Synchronized
    fun isInUse(packageHash: String): Boolean =
        packageHash == servedHash || packageHash == state.current?.packageHash || packageHash == state.previous?.packageHash

    @Synchronized
    fun cachedBinaryHash(): String? = state.binaryHash

    @Synchronized
    fun saveBinaryHash(hash: String) = commit(state.copy(binaryHash = hash))

    private fun view(metadata: PackageMetadata) = PackageView(
        metadata,
        isFirstRun = didUpdate && metadata.packageHash == state.current?.packageHash && metadata.packageHash == servedHash,
        failedInstall = metadata.packageHash in state.failedHashes,
    )

    private fun rollback(s: CodePushState): CodePushState {
        val failed = s.current ?: return s.copy(pending = null)
        store.deletePackage(failed.packageHash)
        return s.copy(
            current = s.previous,
            previous = null,
            pending = null,
            failedHashes = (s.failedHashes + failed.packageHash).distinct(),
            rollbackReport = failed,
        )
    }

    /** A package whose files are gone cannot be served; step back to one that can, ending at the store bundle. */
    private fun fallBackFromMissing(start: CodePushState): CodePushState {
        var s = start
        while (s.current != null && !store.isStaged(s.current!!.packageHash)) {
            Log.warn("Package ${s.current!!.packageHash} is missing its files: falling back.")
            s = s.copy(current = s.previous, previous = null, pending = null)
            didUpdate = false
        }
        if (s.previous != null && !store.isStaged(s.previous!!.packageHash)) {
            s = s.copy(previous = null)
        }
        return s
    }

    private fun commit(s: CodePushState) {
        state = s
        store.write(s)
    }
}
