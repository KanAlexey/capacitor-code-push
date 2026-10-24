package io.github.kanalexey.codepush

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class UpdateStateMachineTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var store: StateStore

    @Before
    fun setUp() {
        store = StateStore(File(temporary.root, "capacitor-codepush"))
    }

    /** A new process: a fresh machine over the same folder, as after the app was killed. */
    private fun launch(binary: BinaryIdentity = BINARY, legacy: String? = null): Pair<UpdateStateMachine, String?> {
        val machine = UpdateStateMachine(store)
        return machine to machine.coldStart(binary) { legacy }
    }

    @Test
    fun `a first launch serves the store bundle and records the binary`() {
        val (machine, served) = launch()

        assertNull(served)
        assertNull(machine.currentPackage())
        assertEquals(BINARY, store.read().binary)
    }

    @Test
    fun `an IMMEDIATE install is launched at once and is a first run`() {
        val (machine, _) = launch()
        store.stageFake("q")

        assertTrue(machine.install("q", InstallModes.IMMEDIATE, 0))
        assertEquals("q", machine.applyPending())

        assertEquals("q", machine.servedHash)
        assertTrue(machine.didUpdate)
        assertTrue(machine.currentPackage()!!.isFirstRun)
        assertEquals(true, store.read().pending?.isLoading)
    }

    @Test
    fun `an ON_NEXT_RESTART install waits, then launches at the next cold start`() {
        val (machine, _) = launch()
        store.stageFake("q")

        assertFalse(machine.install("q", InstallModes.ON_NEXT_RESTART, 0))
        assertNull(machine.servedHash)
        assertEquals("q", machine.pendingPackage()?.metadata?.packageHash)
        assertNull(machine.currentPackage())

        val (next, served) = launch()
        assertEquals("q", served)
        assertTrue(next.didUpdate)
        assertNull(next.pendingPackage())
        assertEquals(true, store.read().pending?.isLoading)
    }

    @Test
    fun `a launched package that never confirmed is rolled back at the next cold start, and reported`() {
        val (machine, _) = launch()
        store.stageFake("q")
        machine.install("q", InstallModes.IMMEDIATE, 0)
        machine.applyPending()

        val (next, served) = launch()

        assertNull(served)
        assertFalse(store.packageDir("q").exists())
        assertTrue(next.isFailed("q"))
        assertFalse(next.didUpdate)
        val report = next.notifyApplicationReady(BINARY.versionName)!!
        assertEquals(StatusReport.FAILED, report.status)
        assertEquals("q", report.pkg?.packageHash)
        assertNull(store.read().rollbackReport)
    }

    @Test
    fun `a rollback returns to the previous confirmed package, not the store bundle`() {
        val (machine, _) = launch()
        store.stageFake("p")
        machine.install("p", InstallModes.IMMEDIATE, 0)
        machine.applyPending()
        machine.notifyApplicationReady(BINARY.versionName)
        store.stageFake("q")
        machine.install("q", InstallModes.ON_NEXT_RESTART, 0)

        launch() // q launched
        val (_, served) = launch() // q never confirmed

        assertEquals("p", served)
        assertTrue(store.isStaged("p"))
        assertEquals(listOf("q"), store.read().failedHashes)
    }

    @Test
    fun `notifyApplicationReady confirms a launched package, so the next cold start keeps it`() {
        val (machine, _) = launch()
        store.stageFake("p")
        machine.install("p", InstallModes.IMMEDIATE, 0)
        machine.applyPending()
        machine.notifyApplicationReady(BINARY.versionName)
        store.stageFake("q")
        machine.install("q", InstallModes.IMMEDIATE, 0)
        machine.applyPending()

        machine.notifyApplicationReady(BINARY.versionName)

        assertNull(store.read().pending)
        assertNull(store.read().previous)
        assertFalse("the previous package is no longer needed", store.packageDir("p").exists())
        val (next, served) = launch()
        assertEquals("q", served)
        assertFalse(next.didUpdate)
        assertFalse(next.currentPackage()!!.isFirstRun)
    }

    @Test
    fun `notifyApplicationReady leaves an update that has not been launched yet alone`() {
        val (machine, _) = launch()
        store.stageFake("p")
        machine.install("p", InstallModes.IMMEDIATE, 0)
        machine.applyPending()
        machine.notifyApplicationReady(BINARY.versionName)
        store.stageFake("q")
        machine.install("q", InstallModes.ON_NEXT_RESTART, 0)

        machine.notifyApplicationReady(BINARY.versionName)

        assertEquals("q", store.read().pending?.packageHash)
        assertEquals("p", store.read().previous?.packageHash)
        assertTrue("p is served", store.isStaged("p"))
        assertEquals("p", machine.currentPackage()?.metadata?.packageHash)
    }

    @Test
    fun `a second install before a restart replaces the first and keeps the last good package`() {
        val (machine, _) = launch()
        store.stageFake("p")
        machine.install("p", InstallModes.IMMEDIATE, 0)
        machine.applyPending()
        machine.notifyApplicationReady(BINARY.versionName)
        store.stageFake("q")
        store.stageFake("r")

        machine.install("q", InstallModes.ON_NEXT_RESTART, 0)
        machine.install("r", InstallModes.ON_NEXT_RESTART, 0)

        val state = store.read()
        assertEquals("r", state.current?.packageHash)
        assertEquals("p", state.previous?.packageHash)
        assertFalse(store.packageDir("q").exists())
    }

    @Test
    fun `an install over a running unconfirmed package keeps the served folder until the next cold start`() {
        val (machine, _) = launch()
        store.stageFake("q")
        machine.install("q", InstallModes.IMMEDIATE, 0)
        machine.applyPending()
        store.stageFake("r")

        machine.install("r", InstallModes.ON_NEXT_RESTART, 0)

        assertTrue("q is still being served", store.isStaged("q"))
        val (_, served) = launch()
        assertEquals("r", served)
        assertFalse("collected once nothing names it", store.packageDir("q").exists())
    }

    @Test
    fun `installing the running confirmed package again changes nothing`() {
        val (machine, _) = launch()
        store.stageFake("q")
        machine.install("q", InstallModes.IMMEDIATE, 0)
        machine.applyPending()
        machine.notifyApplicationReady(BINARY.versionName)

        assertFalse(machine.install("q", InstallModes.IMMEDIATE, 0))
        assertNull(store.read().pending)
    }

    @Test
    fun `a new binary deletes every package and starts from the store bundle, keeping the telemetry`() {
        val (machine, _) = launch()
        store.stageFake("q")
        machine.install("q", InstallModes.IMMEDIATE, 0)
        machine.applyPending()
        machine.recordStatusReported(Telemetry.updateReport(metadata("q", "v-q"), null)!!)
        machine.notifyApplicationReady(BINARY.versionName)

        val (next, served) = launch(BINARY.copy(buildStamp = "1800000000000"))

        assertNull(served)
        assertFalse(store.packagesDir.exists() && store.packagesDir.list()!!.isNotEmpty())
        val state = store.read()
        assertNull(state.current)
        assertEquals(emptyList<String>(), state.failedHashes)
        assertEquals("key-1:v-q", state.lastReportedIdentifier)
        val report = next.notifyApplicationReady(BINARY.versionName)!!
        assertEquals(BINARY.versionName, report.appVersion)
        assertEquals("v-q", report.previousLabelOrAppVersion)
        assertEquals("key-1", report.previousDeploymentKey)
    }

    @Test
    fun `failed hashes are forgotten with the binary they failed on`() {
        val (machine, _) = launch()
        store.stageFake("q")
        machine.install("q", InstallModes.IMMEDIATE, 0)
        machine.applyPending()
        launch()

        val (next, _) = launch(BINARY.copy(versionName = "2.4.0", versionCode = "240"))

        assertFalse(next.isFailed("q"))
    }

    @Test
    fun `an ON_NEXT_RESUME update applies only after the minimum time in the background`() {
        val (machine, _) = launch()
        store.stageFake("q")
        machine.install("q", InstallModes.ON_NEXT_RESUME, 30)

        assertNull(machine.onResume(29))
        assertEquals("q", machine.onResume(30))
        assertTrue(machine.didUpdate)
        assertNull("applied once", machine.onResume(60))
    }

    @Test
    fun `an ON_NEXT_RESTART update does not apply on a resume`() {
        val (machine, _) = launch()
        store.stageFake("q")
        machine.install("q", InstallModes.ON_NEXT_RESTART, 0)

        assertNull(machine.onResume(3600))
    }

    @Test
    fun `restart applies a pending update, reloads what is served without one, or does nothing when asked`() {
        val (machine, _) = launch()
        assertEquals(RestartDecision(reload = true, servedHash = null), machine.restart(false))
        assertEquals(RestartDecision(reload = false, servedHash = null), machine.restart(true))

        store.stageFake("q")
        machine.install("q", InstallModes.ON_NEXT_RESTART, 0)

        assertEquals(RestartDecision(reload = true, servedHash = "q"), machine.restart(true))
        assertEquals(true, store.read().pending?.isLoading)
    }

    @Test
    fun `a package whose files disappeared is not served`() {
        val (machine, _) = launch()
        store.stageFake("q")
        machine.install("q", InstallModes.IMMEDIATE, 0)
        machine.applyPending()
        machine.notifyApplicationReady(BINARY.versionName)
        File(store.packageDir("q"), "index.html").delete()

        val (next, served) = launch()

        assertNull(served)
        assertNull(next.currentPackage())
        assertNull(store.read().current)
    }

    @Test
    fun `install refuses a package that was not downloaded`() {
        val (machine, _) = launch()

        assertThrowsCode<CodePushException>(CodePushException.NOT_STAGED) {
            machine.install("nothing-here", InstallModes.IMMEDIATE, 0)
        }
    }

    @Test
    fun `an unreadable state file reads as the store bundle`() {
        store.root.mkdirs()
        File(store.root, "state.json").writeText("{not json")

        val (machine, served) = launch()

        assertNull(served)
        assertNull(machine.currentPackage())
    }

    @Test
    fun `a cold start collects folders nothing names`() {
        launch()
        store.stageFake("stray")

        launch()

        assertFalse(store.packageDir("stray").exists())
    }

    @Test
    fun `the legacy identifier is read only when no state exists yet`() {
        launch(legacy = "key-1:v3")
        assertEquals("key-1:v3", store.read().lastReportedIdentifier)

        launch(legacy = "other")
        assertEquals("key-1:v3", store.read().lastReportedIdentifier)
    }

    @Test
    fun `reports on the store bundle are sent once, and a failed one is retried`() {
        val (machine, _) = launch()

        val first = machine.notifyApplicationReady(BINARY.versionName)!!
        assertEquals(StatusReport(appVersion = BINARY.versionName), first)
        machine.saveStatusReportForRetry(first)

        assertEquals("the same report is due again", first, machine.notifyApplicationReady(BINARY.versionName))
        machine.recordStatusReported(first)

        assertNull(machine.notifyApplicationReady(BINARY.versionName))
        assertNull(store.read().retryReport)
    }

    @Test
    fun `a launched package is reported once the server took it`() {
        val (machine, _) = launch()
        machine.recordStatusReported(machine.notifyApplicationReady(BINARY.versionName)!!)
        store.stageFake("q", label = "v9")
        machine.install("q", InstallModes.IMMEDIATE, 0)
        machine.applyPending()

        val report = machine.notifyApplicationReady(BINARY.versionName)!!
        assertEquals(StatusReport.SUCCEEDED, report.status)
        assertEquals("v9", report.pkg?.label)
        assertEquals(BINARY.versionName, report.previousLabelOrAppVersion)
        assertNull(report.previousDeploymentKey)

        machine.recordStatusReported(report)
        assertNull(machine.notifyApplicationReady(BINARY.versionName))
    }

    @Test
    fun `a stored retry is sent when nothing else is due`() {
        val (machine, _) = launch()
        machine.recordStatusReported(machine.notifyApplicationReady(BINARY.versionName)!!)
        val retry = Telemetry.rollbackReport(metadata("old"))
        machine.saveStatusReportForRetry(retry)

        val (next, _) = launch()

        assertEquals(retry, next.notifyApplicationReady(BINARY.versionName))
        assertNull(store.read().retryReport)
    }
}
