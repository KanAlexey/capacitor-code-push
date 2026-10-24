package io.github.kanalexey.codepush

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.AssetManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.pm.PackageInfoCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Logger
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The Capacitor side of the plugin: it maps calls onto [UpdateStateMachine] and the staging classes, keeps that work
 * off the bridge's thread, and points Capacitor at the folder the state machine chose (DESIGN.md §9).
 */
@CapacitorPlugin(name = "CodePush")
class CodePushPlugin : Plugin() {
    private var pausedAt = 0L

    override fun load() {
        Log.sink = { level, message -> if (level == "W") Logger.warn(TAG, message) else Logger.info(TAG, message) }
        val appContext = context.applicationContext
        val served = synchronized(Companion) {
            val existing = process
            if (existing != null) {
                // The activity, and with it the bridge, was recreated inside this process: the cold start already
                // happened, so running it again would read this process's own launch as a crash.
                existing.machine.servedHash
            } else {
                val store = StateStore(File(appContext.filesDir, ROOT))
                val machine = UpdateStateMachine(store)
                val hash = machine.coldStart(binaryIdentity(appContext)) { legacyIdentifier(appContext) }
                removeLegacyFolder(appContext)
                process = ProcessState(store, machine)
                hash
            }
        }
        // Capacitor reads this right after the plugins load, in Bridge.loadWebView().
        setPersistedServerPath(appContext, served?.let { state.store.packageDir(it).absolutePath } ?: "")
    }

    @PluginMethod
    fun getConfiguration(call: PluginCall) {
        val result = JSObject()
            .put("appVersion", binaryIdentity(context).versionName)
            .put("clientUniqueId", clientUniqueId(context))
        config.getString("serverUrl")?.takeIf { it.isNotEmpty() }?.let { result.put("serverUrl", it) }
        config.getString("androidDeploymentKey")?.takeIf { it.isNotEmpty() }?.let { result.put("deploymentKey", it) }
        config.getString("publicKey")?.takeIf { it.isNotEmpty() }?.let { result.put("publicKey", it) }
        call.resolve(result)
    }

    @PluginMethod
    fun getBinaryHash(call: PluginCall) = work.run(call) {
        val hash = state.machine.cachedBinaryHash() ?: PackageHasher.hash(AssetTree(context.assets, PUBLIC), "www")
            .also { state.machine.saveBinaryHash(it) }
        JSObject().put("hash", hash)
    }

    @PluginMethod
    fun getCurrentPackage(call: PluginCall) = stateWork.run(call) {
        JSObject().put("package", state.machine.currentPackage()?.let(::toJs) ?: JSONObject.NULL)
    }

    @PluginMethod
    fun getPendingPackage(call: PluginCall) = stateWork.run(call) {
        JSObject().put("package", state.machine.pendingPackage()?.let(::toJs) ?: JSONObject.NULL)
    }

    @PluginMethod
    fun isFailedUpdate(call: PluginCall) = stateWork.run(call) {
        JSObject().put("failed", state.machine.isFailed(requireString(call, "packageHash")))
    }

    @PluginMethod
    fun downloadPackage(call: PluginCall) = work.run(call) {
        val remote = call.getObject("package")
            ?: throw CodePushException(CodePushException.INVALID_ARGUMENT, "downloadPackage needs a package.")
        val metadata = PackageMetadata(
            deploymentKey = remote.optString("deploymentKey"),
            description = remote.optString("description"),
            label = remote.optString("label"),
            appVersion = binaryIdentity(context).versionName,
            isMandatory = remote.optBoolean("isMandatory"),
            packageHash = StateStore.checkedHash(remote.optString("packageHash")),
            packageSize = remote.optLong("packageSize"),
        )
        val machine = state.machine
        val store = state.store
        if (!(machine.isInUse(metadata.packageHash) && store.isStaged(metadata.packageHash))) {
            val zip = File(store.downloadDir.apply { deleteRecursively() }, "update.zip")
            Downloader(config.getBoolean("allowInsecureDownloads", false))
                .download(remote.optString("downloadUrl"), zip, metadata.packageSize) { received, total ->
                    notifyListeners("downloadProgress", JSObject().put("totalBytes", total).put("receivedBytes", received))
                }
            val base = machine.diffBase()?.let { pkg ->
                BaseSource { destination -> store.packageDir(pkg.packageHash).copyRecursively(destination, true) }
            } ?: AssetTree(context.assets, PUBLIC).asBaseSource()
            PackageStager(store).stage(zip, metadata, base, !config.getString("publicKey").isNullOrEmpty())
        }
        JSObject().put(
            "package",
            toJs(PackageView(metadata, isFirstRun = false, failedInstall = machine.isFailed(metadata.packageHash))),
        )
    }

    @PluginMethod
    fun installPackage(call: PluginCall) = stateWork.run(call) {
        val applyNow = state.machine.install(
            requireString(call, "packageHash"),
            call.getInt("installMode") ?: InstallModes.ON_NEXT_RESTART,
            call.getInt("minimumBackgroundDuration") ?: 0,
        )
        if (applyNow) {
            state.machine.applyPending()?.let { serve(it) }
        }
        JSObject()
    }

    @PluginMethod
    fun notifyApplicationReady(call: PluginCall) = stateWork.run(call) {
        val report = state.machine.notifyApplicationReady(binaryIdentity(context).versionName)
        JSObject().put("statusReport", report?.toJson() ?: JSONObject.NULL)
    }

    @PluginMethod
    fun recordStatusReported(call: PluginCall) = stateWork.run(call) {
        state.machine.recordStatusReported(requireReport(call))
        JSObject()
    }

    @PluginMethod
    fun saveStatusReportForRetry(call: PluginCall) = stateWork.run(call) {
        state.machine.saveStatusReportForRetry(requireReport(call))
        JSObject()
    }

    @PluginMethod
    fun restartApplication(call: PluginCall) = stateWork.run(call) {
        val decision = state.machine.restart(call.getBoolean("onlyIfUpdateIsPending") ?: false)
        if (decision.reload) {
            serve(decision.servedHash)
        }
        JSObject().put("restarted", decision.reload)
    }

    override fun handleOnPause() {
        pausedAt = SystemClock.elapsedRealtime()
    }

    override fun handleOnResume() {
        if (pausedAt == 0L) {
            return
        }
        val seconds = (SystemClock.elapsedRealtime() - pausedAt) / 1000
        stateWork.executor.execute {
            try {
                state.machine.onResume(seconds)?.let { serve(it) }
            } catch (e: Exception) {
                Log.warn("Applying an update on resume failed: ${e.message}")
            }
        }
    }

    /**
     * Points the running web view at [packageHash] (null = the store bundle) and records it for the next cold
     * start. The reload waits a moment so the promise that led here reaches JavaScript first.
     */
    private fun serve(packageHash: String?) {
        val path = packageHash?.let { state.store.packageDir(it).absolutePath }
        setPersistedServerPath(context, path ?: "")
        Handler(Looper.getMainLooper()).postDelayed({
            if (path == null) bridge.setServerAssetPath(PUBLIC) else bridge.setServerBasePath(path)
        }, RELOAD_DELAY_MS)
    }

    private fun toJs(view: PackageView): JSObject {
        val json = JSObject.fromJSONObject(view.metadata.toJson())
        json.put("isFirstRun", view.isFirstRun)
        json.put("failedInstall", view.failedInstall)
        return json
    }

    private fun requireString(call: PluginCall, name: String): String =
        call.getString(name) ?: throw CodePushException(CodePushException.INVALID_ARGUMENT, "Missing $name.")

    private fun requireReport(call: PluginCall): StatusReport =
        call.getObject("statusReport")?.let { StatusReport.fromJson(it) }
            ?: throw CodePushException(CodePushException.INVALID_ARGUMENT, "Missing statusReport.")

    private val state: ProcessState
        get() = process ?: throw IllegalStateException("CodePush was not loaded.")

    /** A serial executor that answers a call with what the block returns, or rejects with its error code. */
    private class Worker(val executor: ExecutorService) {
        fun run(call: PluginCall, block: () -> JSObject) {
            executor.execute {
                try {
                    call.resolve(block())
                } catch (e: CodePushException) {
                    call.reject(e.message, e.code, e)
                } catch (e: Exception) {
                    call.reject(e.message ?: e.toString(), e)
                }
            }
        }
    }

    private class ProcessState(val store: StateStore, val machine: UpdateStateMachine)

    /** The APK's web assets, read through the AssetManager. */
    private class AssetTree(private val assets: AssetManager, private val root: String) : FileTree {
        override fun files(): List<String> = mutableListOf<String>().also { walk("", it) }

        private fun walk(relative: String, out: MutableList<String>) {
            val path = if (relative.isEmpty()) root else "$root/$relative"
            val children = assets.list(path).orEmpty()
            if (children.isNotEmpty()) {
                children.forEach { walk(if (relative.isEmpty()) it else "$relative/$it", out) }
            } else if (relative.isNotEmpty() && isFile(path)) {
                out.add(relative)
            }
        }

        // AssetManager lists an empty folder and a file alike, as having no children.
        private fun isFile(path: String): Boolean = try {
            assets.open(path).close()
            true
        } catch (e: FileNotFoundException) {
            false
        }

        override fun open(relativePath: String): InputStream = assets.open("$root/$relativePath")

        fun asBaseSource() = BaseSource { destination ->
            files().forEach { relative ->
                val target = File(destination, relative)
                target.parentFile?.mkdirs()
                open(relative).use { input -> target.outputStream().use { input.copyTo(it) } }
            }
        }
    }

    companion object {
        private const val TAG = "CodePush"
        private const val ROOT = "capacitor-codepush"
        private const val PUBLIC = "public"
        private const val RELOAD_DELAY_MS = 250L
        private const val CAPACITOR_PREFS = "CapWebViewSettings"
        private const val CAPACITOR_SERVER_PATH = "serverBasePath"

        @Volatile
        private var process: ProcessState? = null

        private val stateWork = Worker(Executors.newSingleThreadExecutor())
        private val work = Worker(Executors.newSingleThreadExecutor())

        private fun binaryIdentity(context: Context): BinaryIdentity {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            return BinaryIdentity(
                versionName = info.versionName ?: "",
                versionCode = PackageInfoCompat.getLongVersionCode(info).toString(),
                buildStamp = info.lastUpdateTime.toString(),
            )
        }

        /** The id cordova-plugin-device reported as `device.uuid`, so the server keeps counting the same device. */
        @SuppressLint("HardwareIds")
        private fun clientUniqueId(context: Context): String =
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""

        private fun setPersistedServerPath(context: Context, path: String) {
            context.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(CAPACITOR_SERVER_PATH, path)
                .apply()
        }

        /** cordova-plugin-code-push's last reported version, read once when this plugin has no state yet. */
        private fun legacyIdentifier(context: Context): String? {
            val prefs = context.getSharedPreferences("CODE_PUSH_LAST_VERSION", Context.MODE_PRIVATE)
            return Telemetry.identifierFromLegacy(
                prefs.getString("LAST_VERSION_LABEL_OR_APP_VERSION_KEY", null),
                prefs.getString("LAST_VERSION_DEPLOYMENT_KEY_KEY", null),
            )
        }

        /** cordova-plugin-code-push's packages, unless that plugin is still in the app and may serve one. */
        private fun removeLegacyFolder(context: Context) {
            val legacy = File(context.filesDir, "codepush")
            if (!legacy.exists()) {
                return
            }
            val cordovaPluginPresent = try {
                Class.forName("com.microsoft.cordova.CodePush")
                true
            } catch (e: ClassNotFoundException) {
                false
            }
            if (!cordovaPluginPresent) {
                legacy.deleteRecursively()
            }
        }
    }
}
