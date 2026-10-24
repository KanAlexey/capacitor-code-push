# capacitor-code-push

## Why this plugin exists

Microsoft's [cordova-plugin-code-push](https://github.com/microsoft/cordova-plugin-code-push) was archived in 2021, and
the CodePush-compatible servers that replaced App Center, such as [Revopush](https://revopush.org), ship clients for
React Native only. An app moving from Cordova to Capacitor can keep running the Cordova plugin through Capacitor's
Cordova layer, with patches, but it then carries five more Cordova plugins only for CodePush (file, zip, dialogs,
device, advanced-http) and serves updates through a web view engine Capacitor does not have.

This plugin is a native Capacitor 8 client instead:

- **The same protocol and the same device.** It speaks the CodePush acquisition protocol, sends the client id
  cordova-plugin-device sent, and carries the Cordova plugin's last reported version over, so the server keeps
  counting a device as the same one across the switch.
- **Served the way Capacitor serves.** A package is a folder Capacitor's bridge serves, chosen before the first page
  load, so a cold start on an update loads the page once.
- **The install and rollback rules of react-native-code-push.** A package that never calls
  `notifyApplicationReady` is rolled back at the next cold start and reported; a new binary starts from the store
  bundle again. DESIGN.md has the state machine.
- **No dialog of its own.** `sync` takes a required `onUpdateAvailable` callback, so the app asks in its own words and
  language.

Also here: tests that need no device (Vitest, Kotlin on the JVM, XCTest on a simulator), an end-to-end run of the demo
app on an iOS simulator against a local CodePush server, and a demo app in `demo/` that installs the plugin as npm
would ship it. How it works, and why, is in [DESIGN.md](DESIGN.md).

> **Not yet measured against a real Revopush release.** DESIGN.md §17 lists what only that can prove.

![Platform](https://img.shields.io/badge/platform-android%20%7C%20ios-lightgrey.svg)

## Installation

```bash
npm install capacitor-code-push
npx cap sync
```

## Supported platforms

- Android: API 24 and later, Capacitor 8 (JDK 21 to build)
- iOS: 15 and later, Capacitor 8 through Swift Package Manager (Xcode 26)

## Configuration

```ts
// capacitor.config.ts
plugins: {
  CodePush: {
    serverUrl: 'https://api.revopush.org/',
    iosDeploymentKey: '…',
    androidDeploymentKey: '…',
  },
},
```

`CodePush.configure({ serverUrl, deploymentKey })` overrides both at run time. `allowInsecureDownloads: true` lets
a local test server serve plain HTTP. `publicKey` is refused for now: signature verification is not built yet, so a
configured key makes every install fail rather than install unverified code.

## Usage

```ts
import { CodePush, InstallMode, SyncStatus } from 'capacitor-code-push';

// On every start, not only when online: an update that never confirms is rolled back at the next cold start.
await CodePush.notifyApplicationReady();

const status = await CodePush.sync(
  {
    installMode: InstallMode.ON_NEXT_RESTART,
    // Required: decide what the user is asked. `() => true` installs without asking.
    onUpdateAvailable: async (update) => confirm(`Install ${update.label}?`),
  },
  { onStatus: (s) => console.log(SyncStatus[s]), onProgress: (p) => console.log(p.receivedBytes, p.totalBytes) },
);
if (status === SyncStatus.UPDATE_INSTALLED) {
  await CodePush.restartApplication();
}
```

Every call is described under [API](#api) below.

## Releasing an update

Release a copy of the app's web build placed in a folder named `www`:

```bash
revopush release <app> ./release/www <targetBinaryVersion>
```

The plugin serves the folder that holds `index.html`, and hashes the store bundle under the same `www` prefix, so the
server can tell a device that already runs the release. The binary version is `versionName` on Android and
`CFBundleShortVersionString` on iOS; make sure the iOS build sets `MARKETING_VERSION`.

## Moving from cordova-plugin-code-push

Remove cordova-plugin-code-push in the same app update that adds this plugin; never ship both, since both would steer
the web view. The update is a new binary, so every device starts on the store bundle. The plugin carries
cordova-plugin-code-push's last reported version over once, so the first report names where the device came from,
and deletes that plugin's `codepush/` folder. Drop `window.CodePushServerUrl` and `window.CodePushDeploymentKey` in
favour of `configure()`.

## Demo

`demo/` is a Capacitor app with one button per call. `npm run ios:sync` (or `android:sync`) in `demo/` packs the
plugin the way npm would ship it, installs that copy, builds the web app and syncs the native project; open it in
Xcode or Android Studio from there. The same app carries the autopilot the end-to-end tests drive.

## Tests

| Layer | Command | Where |
| --- | --- | --- |
| TypeScript, with its coverage floor | `npm run test:unit:coverage` | `test/unit` |
| The type contract (what must not compile) | `npm run typecheck:test` | `test/types` |
| Kotlin on the JVM, with its floor | `npm run test:android:coverage` | `android/src/test` |
| XCTest on an iOS simulator, with its floor | `npm run test:ios:coverage` | `test/ios` |
| The demo against a local CodePush server, on an iOS simulator | `npm run test:e2e:ios` | `test/e2e` |

`test/fixtures/hash` holds a release and the package hash the Revopush CLI computes for it; the TypeScript, Kotlin
and Swift hashers are all checked against it. Floors are in `test/coverage/floors.json`: they hold what is measured,
so coverage cannot fall without somebody lowering one. `IOS_SIMULATOR=<name or udid>` picks the simulator.

## Author

Aleksei Kan, https://github.com/KanAlexey

## LICENSE

**capacitor-code-push** is licensed under the Apache License 2.0; see the LICENSE file. `src/acquisition-client.ts` is
adapted from microsoft/code-push and carries its MIT notice.

## API

<docgen-index>

* [`configure(...)`](#configure)
* [`sync(...)`](#sync)
* [`checkForUpdate(...)`](#checkforupdate)
* [`download(...)`](#download)
* [`install(...)`](#install)
* [`getCurrentPackage()`](#getcurrentpackage)
* [`getPendingPackage()`](#getpendingpackage)
* [`notifyApplicationReady()`](#notifyapplicationready)
* [`restartApplication(...)`](#restartapplication)
* [Interfaces](#interfaces)
* [Enums](#enums)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

### configure(...)

```typescript
configure(config: CodePushConfig) => void
```

Runtime settings, merged over the earlier ones.

| Param        | Type                                                      |
| ------------ | --------------------------------------------------------- |
| **`config`** | <code><a href="#codepushconfig">CodePushConfig</a></code> |

--------------------


### sync(...)

```typescript
sync(options: SyncOptions, callbacks?: SyncCallbacks | undefined) => Promise<SyncStatus>
```

Confirms the running package, checks for an update, asks `onUpdateAvailable`, then downloads and installs.
Resolves with `UP_TO_DATE`, `UPDATE_IGNORED`, `UPDATE_INSTALLED`, or `IN_PROGRESS` when another sync is
running. On failure it reports `ERROR` through `onStatus` and rejects with the error.

| Param           | Type                                                    |
| --------------- | ------------------------------------------------------- |
| **`options`**   | <code><a href="#syncoptions">SyncOptions</a></code>     |
| **`callbacks`** | <code><a href="#synccallbacks">SyncCallbacks</a></code> |

**Returns:** <code>Promise&lt;<a href="#syncstatus">SyncStatus</a>&gt;</code>

--------------------


### checkForUpdate(...)

```typescript
checkForUpdate(deploymentKey?: string | undefined) => Promise<RemotePackage | null>
```

Resolves null when the app is up to date or the update needs a newer binary.

| Param               | Type                |
| ------------------- | ------------------- |
| **`deploymentKey`** | <code>string</code> |

**Returns:** <code>Promise&lt;<a href="#remotepackage">RemotePackage</a> | null&gt;</code>

--------------------


### download(...)

```typescript
download(update: RemotePackage, onProgress?: ((progress: DownloadProgress) => void) | undefined) => Promise<LocalPackage>
```

| Param            | Type                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------- |
| **`update`**     | <code><a href="#remotepackage">RemotePackage</a></code>                                |
| **`onProgress`** | <code>((progress: <a href="#downloadprogress">DownloadProgress</a>) =&gt; void)</code> |

**Returns:** <code>Promise&lt;<a href="#localpackage">LocalPackage</a>&gt;</code>

--------------------


### install(...)

```typescript
install(update: LocalPackage, options?: InstallOptions | undefined) => Promise<InstallMode>
```

Resolves with the mode used, before an `IMMEDIATE` update reloads the app.

| Param         | Type                                                      |
| ------------- | --------------------------------------------------------- |
| **`update`**  | <code><a href="#localpackage">LocalPackage</a></code>     |
| **`options`** | <code><a href="#installoptions">InstallOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#installmode">InstallMode</a>&gt;</code>

--------------------


### getCurrentPackage()

```typescript
getCurrentPackage() => Promise<LocalPackage | null>
```

The package being served; null while the app runs its store bundle.

**Returns:** <code>Promise&lt;<a href="#localpackage">LocalPackage</a> | null&gt;</code>

--------------------


### getPendingPackage()

```typescript
getPendingPackage() => Promise<LocalPackage | null>
```

An installed package waiting for a restart or a resume.

**Returns:** <code>Promise&lt;<a href="#localpackage">LocalPackage</a> | null&gt;</code>

--------------------


### notifyApplicationReady()

```typescript
notifyApplicationReady() => Promise<void>
```

Confirms the running package, so the next cold start does not roll it back. Call it on every start.

--------------------


### restartApplication(...)

```typescript
restartApplication(onlyIfUpdateIsPending?: boolean | undefined) => Promise<void>
```

Reloads the app, applying a pending update. With `onlyIfUpdateIsPending`, does nothing without one.

| Param                       | Type                 |
| --------------------------- | -------------------- |
| **`onlyIfUpdateIsPending`** | <code>boolean</code> |

--------------------


### Interfaces


#### CodePushConfig

| Prop                | Type                 | Description                                                                |
| ------------------- | -------------------- | -------------------------------------------------------------------------- |
| **`serverUrl`**     | <code>string</code>  | Overrides `plugins.CodePush.serverUrl` from the Capacitor configuration.   |
| **`deploymentKey`** | <code>string</code>  | Overrides this platform's deployment key from the Capacitor configuration. |
| **`debug`**         | <code>boolean</code> | Log to the console with a `[CodePush]` prefix.                             |


#### SyncOptions

| Prop                      | Type                                                                                                      | Description                                                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`deploymentKey`**       | <code>string</code>                                                                                       | Overrides the configured deployment key for this sync.                                                                                                                                                                                                                                     |
| **`ignoreFailedUpdates`** | <code>boolean</code>                                                                                      | Skip an update that was rolled back on this binary before. Default true.                                                                                                                                                                                                                   |
| **`onUpdateAvailable`**   | <code>(update: <a href="#remotepackage">RemotePackage</a>) =&gt; boolean \| Promise&lt;boolean&gt;</code> | Asked before downloading; required. Resolve false to ignore an optional update. A mandatory update is installed whatever it resolves, so the callback is then only a chance to tell the user. A caller that wants no question says so in its own code: `onUpdateAvailable: () =&gt; true`. |


#### RemotePackage

An update available on the server.

| Prop              | Type                |
| ----------------- | ------------------- |
| **`downloadUrl`** | <code>string</code> |


#### SyncCallbacks

| Prop             | Type                                                                                   | Description                                                   |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **`onStatus`**   | <code>((status: <a href="#syncstatus">SyncStatus</a>) =&gt; void)</code>               | Every status `sync()` passes through, the final one included. |
| **`onProgress`** | <code>((progress: <a href="#downloadprogress">DownloadProgress</a>) =&gt; void)</code> |                                                               |


#### DownloadProgress

| Prop                | Type                |
| ------------------- | ------------------- |
| **`totalBytes`**    | <code>number</code> |
| **`receivedBytes`** | <code>number</code> |


#### LocalPackage

An update downloaded to the device.

| Prop             | Type                 | Description                                                   |
| ---------------- | -------------------- | ------------------------------------------------------------- |
| **`isFirstRun`** | <code>boolean</code> | True during the first launch of this package in this process. |


#### InstallOptions

| Prop                            | Type                                                | Description                                                                     |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| **`installMode`**               | <code><a href="#installmode">InstallMode</a></code> | How an optional update is applied. Default `ON_NEXT_RESTART`.                   |
| **`mandatoryInstallMode`**      | <code><a href="#installmode">InstallMode</a></code> | How a mandatory update is applied. Default `IMMEDIATE`.                         |
| **`minimumBackgroundDuration`** | <code>number</code>                                 | Seconds in the background before an `ON_NEXT_RESUME` update applies. Default 0. |


### Enums


#### SyncStatus

| Members                    | Value          |
| -------------------------- | -------------- |
| **`UP_TO_DATE`**           | <code>0</code> |
| **`UPDATE_INSTALLED`**     | <code>1</code> |
| **`UPDATE_IGNORED`**       | <code>2</code> |
| **`ERROR`**                | <code>3</code> |
| **`IN_PROGRESS`**          | <code>4</code> |
| **`CHECKING_FOR_UPDATE`**  | <code>5</code> |
| **`AWAITING_USER_ACTION`** | <code>6</code> |
| **`DOWNLOADING_PACKAGE`**  | <code>7</code> |
| **`INSTALLING_UPDATE`**    | <code>8</code> |


#### InstallMode

| Members               | Value          | Description                                                                                             |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| **`IMMEDIATE`**       | <code>0</code> | Reload into the update as soon as it is installed.                                                      |
| **`ON_NEXT_RESTART`** | <code>1</code> | Apply the update at the next cold start, or at `restartApplication()`.                                  |
| **`ON_NEXT_RESUME`**  | <code>2</code> | Apply the update when the app comes back from the background after `minimumBackgroundDuration` seconds. |

</docgen-api>
