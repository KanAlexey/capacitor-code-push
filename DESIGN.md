# capacitor-code-push: design

Status: draft, 2026-10-24. Nothing is published yet.

A native Capacitor 8 plugin for CodePush-compatible update servers such as [Revopush](https://revopush.org). It is
written for apps that move from Cordova to Capacitor and today run Microsoft's archived
[cordova-plugin-code-push](https://github.com/microsoft/cordova-plugin-code-push) (2.0.x) through Capacitor's
Cordova layer. It speaks the CodePush protocol itself and does its own downloading, unzipping, hashing and package
switching natively, so it needs none of the Cordova plugins that cordova-plugin-code-push depends on.

## 1. Sources

| What | Where |
| --- | --- |
| The Cordova plugin, JS (~1,600 lines), Android (~1,650), iOS (~1,500 plus ~5,700 vendored JWT/Base64) | microsoft/cordova-plugin-code-push 2.0.x: `bin/www/*.js`, `src/android`, `src/ios`, `plugin.xml` |
| What it takes to run that plugin under Capacitor 8 | Android: serve a package through the bridge (`setServerBasePath`, `setServerAssetPath` for the store bundle) and record it under `CapWebViewSettings/serverBasePath`; iOS: `setServerBasePathWithPath:` on the main queue; settings from `capacitor.config.json`; the store bundle is `public`, not `www` |
| The acquisition protocol | microsoft/code-push `script/acquisition-sdk.js` (MIT) |
| How Revopush computes a release's package hash | `@revopush/code-push-cli` 0.0.11: `script/hash-utils.ts`, `script/management-sdk.ts` (`packageFileFromPath`) |
| How Capacitor 8.5.3 chooses the folder it serves | `@capacitor/android` `Bridge.java` (`loadWebView`, `isNewBinary`, `setServerBasePath`), `@capacitor/ios` `CAPBridgeViewController.swift` (`instanceDescriptor`, `loadWebView`, `setServerBasePath(path:)`), `CapacitorBridge.swift` (`setServerBasePath`) |

## 2. Findings

1. **No package signing in use, so verification is deferred** (§12). Most apps never configured a public key for
   cordova-plugin-code-push; dropping verification for now also drops the 5,700 vendored lines and
   `nimbus-jose-jwt`. A configured key makes every install fail rather than install unverified code.
2. **Revopush's hash rules are not cordova-plugin-code-push's.** The Revopush CLI ignores only `.DS_Store` (any
   depth) and a leading `__MACOSX/`; the Cordova plugin also ignored `.codepushrelease` and `__MACOSX` at any
   depth. This plugin follows the CLI (§11), since the CLI produces the zip the server hashes.
3. **`notifyApplicationReady` must not hang off the network.** cordova-plugin-code-push calls it from `sync()`;
   an app that runs `sync()` only when online never confirms an update opened offline, and the next cold start
   rolls it back. Apps should call `notifyApplicationReady()` on every start (§19).
4. **The binary version is `CFBundleShortVersionString` / `versionName`.** A Capacitor iOS project carries Xcode's
   `MARKETING_VERSION`, which is `1.0` until the build sets it; releases targeting the real version then never
   match. This is the build's to fix; the plugin reports what the binary says.
5. **What the Cordova plugin needed and this one does not**: cordova-plugin-file, cordova-plugin-zip,
   cordova-plugin-dialogs, cordova-plugin-device and cordova-plugin-advanced-http. Whether an app can remove them
   depends on its own uses of them.

## 3. Goals and non-goals

Goals:

- Cover what an app does with CodePush: check, sync and download with progress, install modes, mandatory updates,
  current and pending package, `notifyApplicationReady`, rollback with a report to the server, restart.
- Serve a package through Capacitor's own mechanisms, with no double load on a cold start.
- Keep the install/rollback state machine small, explicit and testable without a device.
- Stay wire-compatible with CodePush servers: the same endpoints, fields and client id as the Cordova plugin.

Non-goals for now: native update dialogs, signature verification, a rollback timeout, download cancellation (the
Cordova plugin's `abortDownload` never cancelled anything), web support beyond a stub, release tooling.

## 4. Architecture

```
app                              capacitor-code-push
───                              ──────────────────────────────────────────────────────────────
plain wrapper object ─────────► CodePush (TS orchestrator: sync, checkForUpdate, download,
                                 install, notifyApplicationReady, reports)
                                   ├─ AcquisitionClient (TS: update_check, report_status/deploy,
                                   │                     report_status/download)
                                   │    └─ CapacitorHttp.request (native HTTP, no CORS)
                                   └─ CodePushNative = registerPlugin('CodePush')   ◄── the only Proxy
                                        │
                   ┌────────────────────┴─────────────────────┐
              Android (Kotlin)                            iOS (Swift, SPM)
 CodePushPlugin (Capacitor glue, thin)        CodePushPlugin (Capacitor glue, thin)
 ├─ UpdateStateMachine  (pure)                ├─ UpdateStateMachine  (pure)
 ├─ StateStore          (state.json)          ├─ StateStore          (state.json)
 ├─ Telemetry           (pure)                ├─ Telemetry           (pure)
 ├─ PackageHasher, Unzipper, DiffApplier      ├─ PackageHasher, Unzipper (ZIPFoundation), DiffApplier
 └─ Downloader (HttpURLConnection)            └─ Downloader (URLSession)
```

Everything below the glue is plain Kotlin/Swift over `java.io.File` / `FileManager`, with no Capacitor or Android
types, so it runs in JVM unit tests and XCTest. The glue does three things only: map calls to the core, run them
off the bridge thread, and switch the folder Capacitor serves.

**The acquisition client is our own**, a TypeScript port of microsoft/code-push's `acquisition-sdk.js` (MIT; its
notice is kept in the file). The npm package `code-push` is deprecated and pulls superagent, proxy-agent and
yazl for its management half, which a device never uses. The port speaks the same three endpoints with the same
fields (§10), takes its configuration explicitly and reads no `window` globals.

Identifiers: npm `capacitor-code-push`, JS name `CodePush` (settings under `plugins.CodePush`), Swift class
`CodePushPlugin`, Kotlin package `io.github.kanalexey.codepush`. Nothing collides with cordova-plugin-code-push
(`com.microsoft.cordova.CodePush`, ObjC `CodePush`), but the two must never be installed in one app: both would
steer the web view.

## 5. Public TypeScript API

Numeric enum values are cordova-plugin-code-push's, so existing comparisons keep working.

```ts
export enum InstallMode { IMMEDIATE = 0, ON_NEXT_RESTART = 1, ON_NEXT_RESUME = 2 }

export enum SyncStatus {
  UP_TO_DATE = 0, UPDATE_INSTALLED = 1, UPDATE_IGNORED = 2, ERROR = 3, IN_PROGRESS = 4,
  CHECKING_FOR_UPDATE = 5, AWAITING_USER_ACTION = 6, DOWNLOADING_PACKAGE = 7, INSTALLING_UPDATE = 8,
}

export interface Package {
  deploymentKey: string; description: string; label: string; appVersion: string;
  isMandatory: boolean; packageHash: string; packageSize: number;
  failedInstall: boolean;              // this hash was rolled back on this binary before
}
export interface RemotePackage extends Package { downloadUrl: string }
export interface LocalPackage extends Package { isFirstRun: boolean }  // first launch of this package in this process

export interface DownloadProgress { totalBytes: number; receivedBytes: number }

export interface SyncOptions {
  deploymentKey?: string;
  installMode?: InstallMode;            // default ON_NEXT_RESTART
  mandatoryInstallMode?: InstallMode;   // default IMMEDIATE
  minimumBackgroundDuration?: number;   // seconds, for ON_NEXT_RESUME; default 0
  ignoreFailedUpdates?: boolean;        // default true
  /** Required. Asked before downloading. Resolve false to ignore an optional update. A mandatory update is
   *  installed whatever it resolves; the callback is then only a chance to tell the user. A caller that wants
   *  no question says so in its own code: `onUpdateAvailable: () => true`. */
  onUpdateAvailable: (update: RemotePackage) => boolean | Promise<boolean>;
}

export interface SyncCallbacks {
  onStatus?: (status: SyncStatus) => void;       // every intermediate status
  onProgress?: (progress: DownloadProgress) => void;
}

export interface CodePushConfig {
  serverUrl?: string;      // overrides capacitor.config at runtime
  deploymentKey?: string;  // likewise
  debug?: boolean;         // console logging with a "[CodePush]" prefix
}

export interface CodePushPlugin {
  configure(config: CodePushConfig): void;
  sync(options: SyncOptions, callbacks?: SyncCallbacks): Promise<SyncStatus>;   // final status, or rejects
  checkForUpdate(deploymentKey?: string): Promise<RemotePackage | null>;
  download(update: RemotePackage, onProgress?: (p: DownloadProgress) => void): Promise<LocalPackage>;
  install(update: LocalPackage, options?: Pick<SyncOptions,
    'installMode' | 'mandatoryInstallMode' | 'minimumBackgroundDuration'>): Promise<InstallMode>;
  getCurrentPackage(): Promise<LocalPackage | null>;   // the package being served; null = store bundle
  getPendingPackage(): Promise<LocalPackage | null>;   // installed, waiting for a restart or resume
  notifyApplicationReady(): Promise<void>;
  restartApplication(onlyIfUpdateIsPending?: boolean): Promise<void>;
}

export const CodePush: CodePushPlugin;
```

Differences from cordova-plugin-code-push, on purpose:

- Promises instead of success/error callbacks; packages are plain data, so `remotePackage.download(...)` becomes
  `CodePush.download(remotePackage)`.
- `sync` resolves with the final status (`UP_TO_DATE`, `UPDATE_IGNORED`, `UPDATE_INSTALLED`, `IN_PROGRESS`) and
  reports every status through `onStatus`; on failure it reports `ERROR` there and rejects with the error, where
  the Cordova plugin called an error callback.
- `updateDialog` (a native, English-only dialog through cordova-plugin-dialogs) is replaced by
  `onUpdateAvailable`, and it is **required**: the Cordova plugin's default was to download without asking, and a
  caller that forgot the question would keep that silently. The type makes forgetting it a compile error; at run
  time, for a caller in plain JavaScript, `sync` rejects with `INVALID_ARGUMENT` before it contacts the server.
  Since a callback is always there, `sync` reports `AWAITING_USER_ACTION` for every update it finds.
- `configure()` replaces the `window.CodePushServerUrl` / `window.CodePushDeploymentKey` globals some forks read.
- `install()` resolves before an `IMMEDIATE` reload, so the caller sees `UPDATE_INSTALLED` (the Cordova plugin did
  the same by calling back before it navigated).

Semantics kept: one `sync` at a time (a second answers `IN_PROGRESS`), `sync` calls `notifyApplicationReady`
first, an update that targets a newer binary counts as up to date, and a previously rolled-back hash is skipped
when `ignoreFailedUpdates` is on.

## 6. Native bridge surface

Internal: the TS orchestrator is its only caller. Each method is one Swift `@objc` method and one Kotlin
`@PluginMethod`.

| Method | Answers | Notes |
| --- | --- | --- |
| `getConfiguration()` | `{ appVersion, clientUniqueId, serverUrl?, deploymentKey?, publicKey? }` | `deploymentKey` is this platform's key |
| `getBinaryHash()` | `{ hash }` | hash of the store bundle, cached per binary (§11) |
| `getCurrentPackage()` / `getPendingPackage()` | `{ package: LocalPackage \| null }` | |
| `isFailedUpdate({ packageHash })` | `{ failed }` | |
| `downloadPackage({ package: RemotePackage })` | `{ package: LocalPackage }` | emits `downloadProgress`; downloads, unzips, applies a diff, verifies, stages (§11) |
| `installPackage({ packageHash, installMode, minimumBackgroundDuration })` | `{}` | §8 |
| `notifyApplicationReady()` | `{ statusReport: StatusReport \| null }` | confirms, then hands over the report to send (§10) |
| `recordStatusReported({ statusReport })` / `saveStatusReportForRetry({ statusReport })` | `{}` | §10 |
| `restartApplication({ onlyIfUpdateIsPending })` | `{ restarted }` | |

Errors reject with a code the orchestrator acts on: `DOWNLOAD_FAILED` (network), `INVALID_PACKAGE`
(unzip, layout, missing `index.html`), `HASH_MISMATCH`, `SIGNATURE_UNSUPPORTED`, `NOT_STAGED`, `INVALID_ARGUMENT`.

Native work never runs on the bridge's own thread: Android has one handler thread for every plugin, so a hash or
an unzip there would stall the whole app. Each side has a serial queue for state and file work, and the download
runs on its own.

## 7. On-device storage

Root: Android `filesDir/capacitor-codepush/`, iOS `Library/NoCloud/capacitor-codepush/` (excluded from backup).
Both differ from cordova-plugin-code-push's `codepush/`, so the two never share a folder.

```
capacitor-codepush/
├─ state.json                 the whole state machine, written atomically (temp file + rename)
├─ packages/
│  ├─ <packageHash>/          a web root: index.html and the rest, served as-is by Capacitor
│  └─ <packageHash>.json      sidecar: the package's metadata as the server described it
└─ download/                  scratch: update.zip, unzipped/, merge/ (cleared before and after each download)
```

```jsonc
// state.json
{
  "schema": 1,
  "binary": { "versionName": "1.2.3", "versionCode": "...", "buildStamp": "..." }, // §8, binary update
  "current":  { /* package metadata */ } | null,    // what is served, or will be once `pending` applies
  "previous": { /* package metadata */ } | null,    // last good package to fall back to; null = store bundle
  "pending":  { "packageHash": "...", "installMode": 1, "minimumBackgroundDuration": 0, "isLoading": false } | null,
  "failedHashes": ["..."],                          // rolled back on this binary
  "rollbackReport": { /* package metadata */ } | null,  // a rollback not yet handed to JS
  "binaryHash": "...",                              // cache for §11, valid for `binary`
  "telemetry": { "lastReportedIdentifier": "<key>:v12" | "1.2.3" | null, "retryReport": { } | null }
}
```

`packageHash` names a folder only after it matches `^[A-Za-z0-9_-]{1,128}$`, so a server answer cannot reach
outside `packages/`. A corrupt `state.json` is read as empty (store bundle) and logged.

## 8. Install and rollback state machine

The model is react-native-code-push's (the client Revopush is built around), adapted to Capacitor's server path.
`pending.isLoading` is the whole crash detector: it is set when a package is launched and cleared by
`notifyApplicationReady`. Finding it set at the next cold start means the package never confirmed.

States, for one binary:

| State | current | pending | Served |
| --- | --- | --- | --- |
| Store | null | null | store bundle |
| Pending | Q | {Q, isLoading: false} | previous (or store) |
| Trial | Q | {Q, isLoading: true} | Q, awaiting `notifyApplicationReady` |
| Confirmed | Q | null | Q |

Transitions:

| Event | Effect |
| --- | --- |
| `installPackage(Q)` while a pending update exists | `current = Q`, `previous` kept (the last good one); the superseded package's folder is left for garbage collection if it is being served |
| `installPackage(Q)` otherwise | `previous = current`, `current = Q` (the old `previous` folder is deleted) |
| …then mode `IMMEDIATE` | apply now: serve Q, `isLoading = true`, `didUpdate = true`, reload the web view after the call resolves |
| …then `ON_NEXT_RESTART` / `ON_NEXT_RESUME` | `pending = {Q, isLoading: false}`; nothing reloads |
| resume after `minimumBackgroundDuration` with `ON_NEXT_RESUME` pending | apply now |
| `restartApplication()` with a pending update | apply now; without one, reload the current package (or nothing when `onlyIfUpdateIsPending`) |
| `notifyApplicationReady()` | `pending = null`, delete `previous`'s folder, `previous = null`; return the status report (§10) |
| cold start, `pending.isLoading` true | **rollback**: `failedHashes += current`, `rollbackReport = current`, `current = previous`, `previous = null`, `pending = null`, delete the failed folder |
| cold start, `pending.isLoading` false | launch it: serve `current`, `isLoading = true`, `didUpdate = true` |
| cold start, binary identity changed | **binary update**: delete `packages/`, reset `current`, `previous`, `pending`, `failedHashes`, `rollbackReport`, `binaryHash`; keep `telemetry`; serve the store bundle |

Cold start runs in the plugin's `load()`, which Capacitor calls on both platforms after the web view exists and
before it loads anything (Android: `registerAllPlugins()` before `loadWebView()`; iOS: plugins load inside
`CapacitorBridge.init`, from `loadView`, before `viewDidLoad` loads the page). In order:

1. Binary identity: Android `versionName`, `versionCode` and `PackageInfo.lastUpdateTime`; iOS
   `CFBundleShortVersionString`, `CFBundleVersion` and the modification date of the bundle's `Info.plist`. This is
   stricter than Capacitor's own `isNewBinary` (version name and code only), so a reinstall of the same version
   also resets, and the plugin always decides before Capacitor does.
2. Rollback or launch as in the table.
3. Check that the folder to serve still has `index.html`; if not, treat it as failed and fall back again. iOS calls
   `fatalLoadError()` when `index.html` is missing, so this check is not optional there.
4. Point Capacitor at it (§9) and garbage-collect any folder in `packages/` that `current` and `previous` do not
   name.

`didUpdate` and a "cold start already handled" flag are process-wide statics. Android can recreate the activity,
and with it the bridge and the plugin, inside one process; without the flag the second `load()` would find
`isLoading` set by the first and roll back a healthy package. (Reading cordova-plugin-code-push's Android side, a
new plugin instance runs its cold-start logic again; whether that rolls back a package on a real device has not
been measured.)

What is not detected: a package that loads but is broken without the process dying stays until the app is
killed. That is cordova-plugin-code-push's behaviour and react-native-code-push's; a rollback timer is a possible
later addition.

## 9. Serving a package through Capacitor

| | Cold start (in `load()`) | Runtime switch (install, resume, restart) | Store bundle |
| --- | --- | --- | --- |
| Android | write `CapWebViewSettings/serverBasePath` = the package folder (or `""`); Capacitor's `loadWebView()` reads it right after | `bridge.setServerBasePath(path)` (it reloads) and the same preference | `bridge.setServerAssetPath("public")`, preference `""` |
| iOS | `bridge.setServerBasePath(path)` on `CapacitorBridge`, which sets the asset path and does not reload; `viewDidLoad` then loads from it | `bridge.setServerBasePath(path)` then load `bridge.config.serverURL` on the main queue | `Bundle.main` `public` |

Why this shape:

- Android's `Bridge.setServerBasePath` needs the local server, which only exists after `loadWebView()`, so at a
  cold start the preference is the only door. Capacitor clears that preference itself on a new binary, which
  agrees with §8.
- iOS persists a server path only under `Library/NoCloud/ionic_built_snapshots/<last path component>`
  (`instanceDescriptor()`), a leftover of Ionic Deploy. Rather than store packages there, the plugin leaves
  Capacitor's key empty and sets the path in `load()`, before the first page load. Setting it through the view
  controller instead (`setServerBasePathWithPath:`) also reloads, so the store bundle starts loading first;
  setting it on the bridge before `viewDidLoad` avoids that double load.
- The origin does not change (`https://localhost` on Android, `capacitor://localhost` on iOS by default), so local
  storage, IndexedDB and cookies carry over between the store bundle and packages.

## 10. Status reporting and the protocol

Native decides what to report; JS sends it and tells native whether it landed. This replaces the Cordova plugin's
native code injecting `window.codePush.reportStatus(...)` on `deviceready`.

`notifyApplicationReady()` (native) picks the first that applies:

1. a stored `rollbackReport` → `{ package, status: 'DeploymentFailed' }`;
2. `didUpdate` and the current package's identifier `deploymentKey:label` (react-native-code-push's form) differs from `lastReportedIdentifier` →
   `{ package, status: 'DeploymentSucceeded', previousLabelOrAppVersion, previousDeploymentKey }`;
3. running the store bundle and `appVersion` differs from `lastReportedIdentifier` →
   `{ appVersion, previousLabelOrAppVersion, previousDeploymentKey }` (also on the very first launch);
4. otherwise a stored `retryReport`.

On success JS calls `recordStatusReported`, which moves `lastReportedIdentifier` (never for `DeploymentFailed`);
on failure `saveStatusReportForRetry`. Every `sync` calls `notifyApplicationReady` first, so a failed report is
retried on the next sync. Reporting never makes `notifyApplicationReady` reject.

Also kept from the Cordova plugin: a download report after a successful download, and a `DeploymentFailed` report
when a downloaded package cannot be installed (unzip, layout, hash).

One deliberate difference: the Cordova plugin reported the store version again only when a binary update also
wiped a package, so a device that moved between binaries without ever taking an update was not reported; (3)
reports every change of binary version.

The acquisition client sends, relative to `serverUrl` (a trailing `/` added when missing):

| Call | Request |
| --- | --- |
| update check | `GET v0.1/public/codepush/update_check?deployment_key&app_version&package_hash&is_companion&label&client_unique_id` (fields left out when null) |
| deploy report | `POST v0.1/public/codepush/report_status/deploy`, JSON `{ app_version, deployment_key, client_unique_id, label?, status?, previous_label_or_app_version?, previous_deployment_key? }` |
| download report | `POST v0.1/public/codepush/report_status/download`, JSON `{ client_unique_id, deployment_key, label }` |

An update check answers `{ update_info }`: `update_app_version` means "newer binary needed" (treated as up to
date), `is_available: false` means up to date, otherwise `label`, `description`, `target_binary_range`,
`is_mandatory`, `package_hash`, `package_size`, `download_url`. A non-200 answer is an error carrying the status
and body. Headers: `X-CodePush-Plugin-Name: native-code-push`, `X-CodePush-Plugin-Version` (this plugin's),
`X-CodePush-SDK-Version: 4.2.3` (the microsoft/code-push release whose protocol the client speaks), and
`Content-Type: application/json` on a POST. The plugin name is the value a
Cordova-based client already sends to Revopush; whether the server keys anything on it is not known, so it is
kept rather than changed.

## 11. Download, unzip, diff and hash

`downloadPackage` does, on its own queue:

1. Validate `packageHash`; refuse a non-HTTPS `downloadUrl` unless `allowInsecureDownloads` is set (for a local
   test server only). Follow up to five redirects, HTTPS to HTTP refused.
2. Stream to `download/update.zip`, emitting `downloadProgress` at most every 64 KiB and once at the end.
3. Unzip into `download/unzipped/`. Refuse any entry that is absolute, contains `..` after normalisation, or is a
   symbolic link.
4. **Diff** (the zip has `hotcodepush.json` at its root): copy the base into `download/merge/www/`, overlay the
   unzipped entries, then delete each path in `deletedFiles` (validated the same way). The base is `current` when
   there is one, else the store bundle, because that is what the update check reported as `package_hash`.
   **Full**: the release root is `download/unzipped/`.
5. Find the web root: the single top-level directory that holds `index.html` (a release of a folder named `www`
   zips its entries as `www/…`), else the release root itself if it holds `index.html`.
6. Verify the hash of a **diff** update: the computed hash of the merged release root must equal `packageHash`,
   or the download fails with `HASH_MISMATCH` (§16). A **full** update is not hashed, as in the Cordova plugin.
7. Move the web root to `packages/<packageHash>/`, write the sidecar, clear `download/`.

The package hash, exactly as Revopush's CLI and server compute it (`hash-utils.ts`):

```
entries = for every file under the release root, path relative to the root's parent ("www/main.js"):
            "<path>:<sha256 hex of the file>"
          skipping a path that starts with "__MACOSX/", equals ".DS_Store" or ends with "/.DS_Store"
hash    = sha256 hex of JSON.stringify(entries sorted by UTF-16 code unit)
```

Both platforms build the JSON string themselves with `JSON.stringify`'s escaping (`"` `\` and control characters
only, `/` and non-ASCII left as they are) instead of a JSON library: `org.json` writes `/` as `\/` and
`NSJSONSerialization` does too, which the Cordova plugin patched over with a string replace. One fixture with
awkward names (spaces, Unicode, a quote, nested folders, an ignored `.DS_Store`) and its hash, computed by a
TypeScript copy of the CLI's algorithm, is checked by all three test suites.

The store bundle's hash (`getBinaryHash`) is the same algorithm over the bundled `public` folder with the prefix
`www`, so it equals the package hash of a release cut from a copy of `public` placed in a folder named `www`.
Then the server can tell a device on the store bundle that it already has the latest release, and can compute a
diff against it. It is computed on first need and cached per binary. Android reads `public` through
`AssetManager.list`, since the Cordova plugin's `cdvasset.manifest` Gradle hook does not exist under Capacitor.

## 12. Signature verification (deferred)

Not built yet (§2.1). If `publicKey` is set, every download fails with `SIGNATURE_UNSUPPORTED` rather than
installing unverified code. A `.codepushrelease` file in an unsigned release is logged and otherwise treated as
content, as the CLI's hash treats it.

When it is wanted: the JWT in `.codepushrelease` is RS256 and its `contentHash` claim is compared with the computed
hash. That is `Signature.getInstance("SHA256withRSA")` with an `X509EncodedKeySpec` on Android, and
`SecKeyCreateWithData` (after stripping the SubjectPublicKeyInfo header) plus `SecKeyVerifySignature` with
`.rsaSignatureMessagePKCS1v15SHA256` on iOS, about 60 lines each. Which hash the signature covers needs checking
against Revopush first: the CLI's signer hashes the folder before it writes `.codepushrelease` into it, while the
server hashes the zip that includes it.

## 13. Configuration

```ts
// capacitor.config.ts
plugins: {
  CodePush: {
    serverUrl: 'https://api.revopush.org/',
    iosDeploymentKey: '…',
    androidDeploymentKey: '…',
    // publicKey: '…',              refused until §12 is built
    // allowInsecureDownloads: true  local test servers only
  },
},
```

Read with Capacitor's `getConfig()` on each side. There is no default server: cordova-plugin-code-push fell back
to App Center, which is shut down, so a missing `serverUrl` is an error. `configure({ serverUrl, deploymentKey })`
overrides both at runtime.

The client id sent to the server is the one cordova-plugin-code-push sent through cordova-plugin-device, so a
server keeps counting a device as the same one across the switch: iOS the `CDVUUID` user default (created from
`identifierForVendor` when absent), Android `Settings.Secure.ANDROID_ID`.

## 14. Migration from cordova-plugin-code-push

The app update that swaps the plugins is a new binary, so §8 already starts it on the store bundle; nothing from
the Cordova plugin's packages is carried over. Once, when `state.json` does not exist yet:

- carry over its last reported version (Android preferences `CODE_PUSH_LAST_VERSION`, iOS user default
  `CODE_PUSH_LAST_VERSION`) into `telemetry.lastReportedIdentifier` (`v<N>` with its key as `key:label`, anything
  else as an app version), so the first report says where the device came from;
- delete its `codepush/` folder, but only if its native class is absent (`com.microsoft.cordova.CodePush` /
  `CodePush`), so a misbuilt app carrying both does not lose that plugin's package.

## 15. What is dropped

| From cordova-plugin-code-push | Replaced by |
| --- | --- |
| cordova-plugin-file (folders, copies, reads) | `java.io.File` / `FileManager` in native |
| cordova-plugin-zip | `java.util.zip` / [ZIPFoundation](https://github.com/weichsel/ZIPFoundation) (SPM, MIT) |
| cordova-plugin-advanced-http for the API and the download, `code-push` npm package | the acquisition client over `CapacitorHttp.request` (in `@capacitor/core`, not gated by its `enabled` flag); native download |
| cordova-plugin-dialogs | `onUpdateAvailable` (§5) |
| cordova-plugin-device (`device.uuid`) | native `clientUniqueId` (§13) |
| vendored JWT/Base64 (iOS, ~5,700 lines), `nimbus-jose-jwt` (Android) | nothing yet (§12) |
| `CDVWKWebViewEngine+CodePush.m`, Ionic web view engine paths, `config.xml` parsing | Capacitor's server path (§9) |
| `build-extras.gradle` (`cdvasset.manifest`, `CODE_PUSH_APK_BUILD_TIME`) | `AssetManager.list`, `PackageInfo.lastUpdateTime` |
| `window.codePush` and the other globals, native-to-JS `evaluateJavaScript` reports | the module's exports, §10 |
| `abortDownload` (cancelled nothing) | dropped |

## 16. Security

- Every byte served comes from the app's private storage, downloaded over HTTPS. A diff update is checked against
  the hash the server announced and fails closed on a mismatch; a full update is trusted as delivered, as in
  cordova-plugin-code-push (§11). If Revopush hashes differently from §11, diff updates fail to install rather
  than installing something unverified.
- Zip entries, `deletedFiles` and `packageHash` are validated before they touch the file system (§7, §11).
- Downloads are HTTPS-only by default; redirects cannot downgrade.
- Signature verification is absent but fails closed if a key is configured (§12).
- Nothing identifying is sent beyond what cordova-plugin-code-push sends (deployment key, app version, labels,
  the client id).

## 17. Testing

Without a device:

| Layer | Tool | Covers |
| --- | --- | --- |
| TypeScript | Vitest, fakes for the native plugin and `CapacitorHttp` | `sync` paths and statuses, the required callback, install-mode choice, mandatory handling, `IN_PROGRESS`, ignored failed updates, `checkForUpdate` building the query package, the acquisition client's requests and answers, report sending and record/retry, download and install failure reports, configuration precedence, the reference hash |
| Android | JUnit on the JVM (`./gradlew test`), real files in temp folders, the JDK's HTTP server for downloads | state machine (every row of §8, the same-process guard, GC), telemetry (§10), hasher against the shared fixture, unzip refusals, diff, downloader (progress, redirects, HTTP refused), migration |
| iOS | XCTest (`xcodebuild test` on a simulator) | the same, for Swift |
| Builds | `./gradlew build`, `xcodebuild` for a generic iOS device | both platforms compile with Capacitor 8.5.3 |

Only a device with real Revopush releases proves:

- Revopush's answers and download URLs (CDN, redirects);
- whether Revopush serves diffs to this client, their exact `hotcodepush.json`, and that its package hash equals
  ours for the merged result (and for the store bundle, which decides whether a device on it is offered a release
  it already has);
- an app on a package: cold start, client-side routing, lazy chunks, no double load, data kept across the switch;
- rollback after a real kill during the trial launch, on both platforms, and its report landing;
- `ON_NEXT_RESUME` timing, `IMMEDIATE` with a progress dialog open;
- the binary-update reset through a real store or test-track install;
- client id continuity and the metrics Revopush shows (active, installed, rolled back);
- hashing the store bundle on a slow Android phone, and the extra disk use.

## 18. Decisions

Answered 2026-10-22:

1. **Dialog**: no native dialog; `onUpdateAvailable` instead (§5).
2. **Signature verification**: deferred, fail-closed if a key is configured (§12).
3. **Full-package hash check**: none; only diff updates are hashed, as in cordova-plugin-code-push (§11).

Answered 2026-10-24:

4. **`onUpdateAvailable` is required** in `SyncOptions`, so `sync` cannot be called without deciding what the user
   is asked (§5).
5. **Own acquisition client** instead of the deprecated `code-push` package or a fork of it (§4, §10).
6. **Name and home**: npm `capacitor-code-push`, a personal public repository, Apache-2.0.

## 19. Using it from an app

- Reach the plugin through a plain wrapper object of your own rather than the Capacitor Proxy, which answers
  every property.
- Call `notifyApplicationReady()` on every start, not only from `sync()` (§2.3).
- Pass runtime keys with `configure()`; stop writing `window.CodePushServerUrl` / `window.CodePushDeploymentKey`.
- Make sure a service worker is not active in the native app, or it can keep serving an old bundle.
- Cut releases from a copy of the web build placed in a folder named `www`, so the store bundle's hash (§11) and
  the release's agree.
- Never install it next to cordova-plugin-code-push.
