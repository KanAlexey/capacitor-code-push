# capacitor-code-push

CodePush client for Capacitor apps: over-the-air web updates from a CodePush-compatible server such as Revopush

## Install

To use npm

```bash
npm install capacitor-code-push
````

To use yarn

```bash
yarn add capacitor-code-push
```

Sync native files

```bash
npx cap sync
```

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
