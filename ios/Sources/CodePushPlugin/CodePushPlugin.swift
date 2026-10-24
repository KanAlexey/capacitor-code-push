import Capacitor
import CodePushCore
import Foundation
import UIKit

/// The Capacitor side of the plugin: it maps calls onto `UpdateStateMachine` and the staging classes, keeps that work
/// off the bridge's queue, and points Capacitor at the folder the state machine chose (DESIGN.md §9).
@objc(CodePushPlugin)
public class CodePushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CodePushPlugin"
    public let jsName = "CodePush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getConfiguration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBinaryHash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentPackage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingPackage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isFailedUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadPackage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "installPackage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notifyApplicationReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recordStatusReported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveStatusReportForRetry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restartApplication", returnType: CAPPluginReturnPromise)
    ]

    /// One per process, so a recreated bridge does not run the cold start again and read this process's own
    /// launch as a crash.
    private static var process: (store: StateStore, machine: UpdateStateMachine)?
    private static let processLock = NSLock()
    private static let stateQueue = DispatchQueue(label: "codepush.state")
    private static let workQueue = DispatchQueue(label: "codepush.work")
    private static let reloadDelay: TimeInterval = 0.25

    private var backgroundedAt: Date?

    override public func load() {
        CodePushLog.sink = { CAPLog.print("⚡️ CodePush: \($0)") }
        let served: String?
        Self.processLock.lock()
        if let existing = Self.process {
            served = existing.machine.servedHash
        } else {
            let store = StateStore(root: Self.root)
            let machine = UpdateStateMachine(store: store)
            do {
                served = try machine.coldStart(binary: Self.binaryIdentity(), legacyIdentifier: Self.legacyIdentifier)
            } catch {
                CAPLog.print("⚡️ CodePush: cold start failed, serving the store bundle: \(error)")
                served = nil
            }
            Self.removeLegacyFolder()
            Self.process = (store, machine)
        }
        Self.processLock.unlock()

        // Capacitor's view controller loads the page in viewDidLoad, after the plugins load, so pointing the bridge
        // at the package here serves it from the first request, with no reload.
        if let hash = served, let path = try? Self.state.store.packageDir(hash).path {
            bridge?.setServerBasePath(path)
        }

        NotificationCenter.default.addObserver(self, selector: #selector(didEnterBackground),
                                               name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(willEnterForeground),
                                               name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    @objc func getConfiguration(_ call: CAPPluginCall) {
        var result: [String: Any] = [
            "appVersion": Self.binaryIdentity().versionName,
            "clientUniqueId": Self.clientUniqueId()
        ]
        let config = getConfig()
        for (key, name) in [("serverUrl", "serverUrl"), ("iosDeploymentKey", "deploymentKey"), ("publicKey", "publicKey")] {
            if let value = config.getString(key), !value.isEmpty {
                result[name] = value
            }
        }
        call.resolve(result)
    }

    @objc func getBinaryHash(_ call: CAPPluginCall) {
        run(call, on: Self.workQueue) {
            let machine = Self.state.machine
            if let cached = machine.cachedBinaryHash() {
                return ["hash": cached]
            }
            guard let bundle = Self.storeBundle else {
                throw CodePushError(CodePushError.invalidPackage, "The app has no public folder.")
            }
            let hash = try PackageHasher.hash(directory: bundle, prefix: "www")
            try machine.saveBinaryHash(hash)
            return ["hash": hash]
        }
    }

    @objc func getCurrentPackage(_ call: CAPPluginCall) {
        run(call, on: Self.stateQueue) { ["package": Self.state.machine.currentPackage()?.dictionary ?? NSNull()] }
    }

    @objc func getPendingPackage(_ call: CAPPluginCall) {
        run(call, on: Self.stateQueue) { ["package": Self.state.machine.pendingPackage()?.dictionary ?? NSNull()] }
    }

    @objc func isFailedUpdate(_ call: CAPPluginCall) {
        run(call, on: Self.stateQueue) {
            ["failed": Self.state.machine.isFailed(try Self.requireString(call, "packageHash"))]
        }
    }

    @objc func downloadPackage(_ call: CAPPluginCall) {
        let config = getConfig()
        let allowInsecure = config.getBoolean("allowInsecureDownloads", false)
        let publicKeyConfigured = !(config.getString("publicKey") ?? "").isEmpty
        run(call, on: Self.workQueue) { [weak self] in
            guard let remote = call.getObject("package").map(Self.plain), var metadata = PackageMetadata(dictionary: remote) else {
                throw CodePushError(CodePushError.invalidArgument, "downloadPackage needs a package.")
            }
            metadata.appVersion = Self.binaryIdentity().versionName
            _ = try StateStore.checkedHash(metadata.packageHash)
            let (store, machine) = Self.state
            if !(machine.isInUse(metadata.packageHash) && store.isStaged(metadata.packageHash)) {
                try? FileManager.default.removeItem(at: store.downloadDir)
                let zip = store.downloadDir.appendingPathComponent("update.zip")
                try Downloader(allowInsecure: allowInsecure).download(
                    url: remote["downloadUrl"] as? String ?? "", to: zip, expectedSize: metadata.packageSize
                ) { received, total in
                    self?.notifyListeners("downloadProgress", data: ["totalBytes": total, "receivedBytes": received])
                }
                let base: BaseSource
                if let pkg = machine.diffBase() {
                    let folder = try store.packageDir(pkg.packageHash)
                    base = { destination in try Self.copyContents(of: folder, to: destination) }
                } else if let bundle = Self.storeBundle {
                    base = { destination in try Self.copyContents(of: bundle, to: destination) }
                } else {
                    base = { _ in throw CodePushError(CodePushError.invalidPackage, "The app has no public folder.") }
                }
                try PackageStager(store: store).stage(zip: zip, metadata: metadata, base: base,
                                                      publicKeyConfigured: publicKeyConfigured)
            }
            let view = PackageView(metadata: metadata, isFirstRun: false, failedInstall: machine.isFailed(metadata.packageHash))
            return ["package": view.dictionary]
        }
    }

    @objc func installPackage(_ call: CAPPluginCall) {
        run(call, on: Self.stateQueue) { [weak self] in
            let machine = Self.state.machine
            let applyNow = try machine.install(
                packageHash: try Self.requireString(call, "packageHash"),
                installMode: call.getInt("installMode") ?? InstallModes.onNextRestart,
                minimumBackgroundDuration: call.getInt("minimumBackgroundDuration") ?? 0)
            if applyNow, let launched = try machine.applyPending() {
                self?.serve(launched)
            }
            return [:]
        }
    }

    @objc func notifyApplicationReady(_ call: CAPPluginCall) {
        run(call, on: Self.stateQueue) {
            let report = try Self.state.machine.notifyApplicationReady(appVersion: Self.binaryIdentity().versionName)
            return ["statusReport": report?.dictionary ?? NSNull()]
        }
    }

    @objc func recordStatusReported(_ call: CAPPluginCall) {
        run(call, on: Self.stateQueue) {
            try Self.state.machine.recordStatusReported(try Self.requireReport(call))
            return [:]
        }
    }

    @objc func saveStatusReportForRetry(_ call: CAPPluginCall) {
        run(call, on: Self.stateQueue) {
            try Self.state.machine.saveStatusReportForRetry(try Self.requireReport(call))
            return [:]
        }
    }

    @objc func restartApplication(_ call: CAPPluginCall) {
        run(call, on: Self.stateQueue) { [weak self] in
            let decision = try Self.state.machine.restart(onlyIfUpdateIsPending: call.getBool("onlyIfUpdateIsPending") ?? false)
            if decision.reload {
                self?.serve(decision.servedHash)
            }
            return ["restarted": decision.reload]
        }
    }

    @objc private func didEnterBackground() {
        backgroundedAt = Date()
    }

    @objc private func willEnterForeground() {
        guard let since = backgroundedAt else { return }
        let seconds = Int(Date().timeIntervalSince(since))
        Self.stateQueue.async { [weak self] in
            do {
                if let launched = try Self.state.machine.onResume(secondsInBackground: seconds) {
                    self?.serve(launched)
                }
            } catch {
                CAPLog.print("⚡️ CodePush: applying an update on resume failed: \(error)")
            }
        }
    }

    /// Points the running web view at `packageHash` (nil = the store bundle) and reloads it. The reload waits a
    /// moment so the promise that led here reaches JavaScript first.
    private func serve(_ packageHash: String?) {
        let path = packageHash.flatMap { try? Self.state.store.packageDir($0).path } ?? Self.storeBundle?.path
        guard let path else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.reloadDelay) { [weak self] in
            guard let bridge = self?.bridge else { return }
            bridge.setServerBasePath(path)
            _ = bridge.webView?.load(URLRequest(url: bridge.config.serverURL))
        }
    }

    /// Runs `work` on `queue` and answers `call` with its result, or rejects with its error code.
    private func run(_ call: CAPPluginCall, on queue: DispatchQueue, _ work: @escaping () throws -> [String: Any]) {
        queue.async {
            do {
                call.resolve(try work())
            } catch let error as CodePushError {
                call.reject(error.message, error.code, error)
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    // MARK: - Process-wide helpers

    private static var state: (store: StateStore, machine: UpdateStateMachine) {
        processLock.lock()
        defer { processLock.unlock() }
        guard let process else { fatalError("CodePush was not loaded.") }
        return process
    }

    private static var root: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("NoCloud", isDirectory: true)
            .appendingPathComponent("capacitor-codepush", isDirectory: true)
    }

    private static var storeBundle: URL? {
        Bundle.main.url(forResource: "public", withExtension: nil)
    }

    private static func binaryIdentity() -> BinaryIdentity {
        let info = Bundle.main.infoDictionary ?? [:]
        let plist = Bundle.main.bundleURL.appendingPathComponent("Info.plist")
        let modified = (try? FileManager.default.attributesOfItem(atPath: plist.path)[.modificationDate] as? Date) ?? nil
        return BinaryIdentity(
            versionName: info["CFBundleShortVersionString"] as? String ?? "",
            versionCode: info["CFBundleVersion"] as? String ?? "",
            buildStamp: modified.map { String(Int64($0.timeIntervalSince1970 * 1000)) } ?? "")
    }

    /// The id cordova-plugin-device reported as `device.uuid`, so the server keeps counting the same device.
    private static func clientUniqueId() -> String {
        let defaults = UserDefaults.standard
        if let existing = defaults.string(forKey: "CDVUUID") {
            return existing
        }
        let id = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        defaults.set(id, forKey: "CDVUUID")
        return id
    }

    /// cordova-plugin-code-push's last reported version, read once when this plugin has no state yet.
    private static func legacyIdentifier() -> String? {
        let last = UserDefaults.standard.dictionary(forKey: "CODE_PUSH_LAST_VERSION")
        return Telemetry.identifierFromLegacy(
            labelOrAppVersion: last?["LAST_VERSION_LABEL_OR_APP_VERSION_KEY"] as? String,
            deploymentKey: last?["LAST_VERSION_DEPLOYMENT_KEY_KEY"] as? String)
    }

    /// cordova-plugin-code-push's packages, unless that plugin is still in the app and may serve one.
    private static func removeLegacyFolder() {
        guard NSClassFromString("CodePush") == nil else { return }
        let legacy = root.deletingLastPathComponent().appendingPathComponent("codepush", isDirectory: true)
        try? FileManager.default.removeItem(at: legacy)
    }

    /// A bridge object as plain Foundation values, nested objects included.
    private static func plain(_ object: JSObject) -> [String: Any] {
        object.mapValues(plainValue)
    }

    private static func plainValue(_ value: JSValue) -> Any {
        if let object = value as? JSObject { return plain(object) }
        if let array = value as? JSArray { return array.map(plainValue) }
        return value
    }

    private static func copyContents(of source: URL, to destination: URL) throws {
        let fileManager = FileManager.default
        for name in try fileManager.contentsOfDirectory(atPath: source.path) {
            try fileManager.copyItem(at: source.appendingPathComponent(name), to: destination.appendingPathComponent(name))
        }
    }

    private static func requireString(_ call: CAPPluginCall, _ name: String) throws -> String {
        guard let value = call.getString(name) else {
            throw CodePushError(CodePushError.invalidArgument, "Missing \(name).")
        }
        return value
    }

    private static func requireReport(_ call: CAPPluginCall) throws -> StatusReport {
        guard let report = call.getObject("statusReport") else {
            throw CodePushError(CodePushError.invalidArgument, "Missing statusReport.")
        }
        return StatusReport(dictionary: plain(report))
    }
}
