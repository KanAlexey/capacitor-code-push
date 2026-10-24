import type { PluginListenerHandle } from '@capacitor/core';

/**
 * When an installed update is applied. The values are cordova-plugin-code-push's, so code written against it keeps
 * comparing the same numbers.
 */
export enum InstallMode {
  /** Reload into the update as soon as it is installed. */
  IMMEDIATE = 0,
  /** Apply the update at the next cold start, or at `restartApplication()`. */
  ON_NEXT_RESTART = 1,
  /** Apply the update when the app comes back from the background after `minimumBackgroundDuration` seconds. */
  ON_NEXT_RESUME = 2,
}

/** What `sync()` is doing or has done. The values are cordova-plugin-code-push's. */
export enum SyncStatus {
  UP_TO_DATE = 0,
  UPDATE_INSTALLED = 1,
  UPDATE_IGNORED = 2,
  ERROR = 3,
  IN_PROGRESS = 4,
  CHECKING_FOR_UPDATE = 5,
  AWAITING_USER_ACTION = 6,
  DOWNLOADING_PACKAGE = 7,
  INSTALLING_UPDATE = 8,
}

/** An update as the server describes it. */
export interface Package {
  deploymentKey: string;
  description: string;
  label: string;
  appVersion: string;
  isMandatory: boolean;
  packageHash: string;
  packageSize: number;
  /** This hash was installed and rolled back on this binary before. */
  failedInstall: boolean;
}

/** An update available on the server. */
export interface RemotePackage extends Package {
  downloadUrl: string;
}

/** An update downloaded to the device. */
export interface LocalPackage extends Package {
  /** True during the first launch of this package in this process. */
  isFirstRun: boolean;
}

export interface DownloadProgress {
  totalBytes: number;
  receivedBytes: number;
}

export interface InstallOptions {
  /** How an optional update is applied. Default `ON_NEXT_RESTART`. */
  installMode?: InstallMode;
  /** How a mandatory update is applied. Default `IMMEDIATE`. */
  mandatoryInstallMode?: InstallMode;
  /** Seconds in the background before an `ON_NEXT_RESUME` update applies. Default 0. */
  minimumBackgroundDuration?: number;
}

export interface SyncOptions extends InstallOptions {
  /** Overrides the configured deployment key for this sync. */
  deploymentKey?: string;
  /** Skip an update that was rolled back on this binary before. Default true. */
  ignoreFailedUpdates?: boolean;
  /**
   * Asked before downloading; required. Resolve false to ignore an optional update. A mandatory update is
   * installed whatever it resolves, so the callback is then only a chance to tell the user. A caller that wants no
   * question says so in its own code: `onUpdateAvailable: () => true`.
   */
  onUpdateAvailable: (update: RemotePackage) => boolean | Promise<boolean>;
}

export interface SyncCallbacks {
  /** Every status `sync()` passes through, the final one included. */
  onStatus?: (status: SyncStatus) => void;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface CodePushConfig {
  /** Overrides `plugins.CodePush.serverUrl` from the Capacitor configuration. */
  serverUrl?: string;
  /** Overrides this platform's deployment key from the Capacitor configuration. */
  deploymentKey?: string;
  /** Log to the console with a `[CodePush]` prefix. */
  debug?: boolean;
}

export interface CodePushPlugin {
  /** Runtime settings, merged over the earlier ones. */
  configure(config: CodePushConfig): void;
  /**
   * Confirms the running package, checks for an update, asks `onUpdateAvailable`, then downloads and installs.
   * Resolves with `UP_TO_DATE`, `UPDATE_IGNORED`, `UPDATE_INSTALLED`, or `IN_PROGRESS` when another sync is
   * running. On failure it reports `ERROR` through `onStatus` and rejects with the error.
   */
  sync(options: SyncOptions, callbacks?: SyncCallbacks): Promise<SyncStatus>;
  /** Resolves null when the app is up to date or the update needs a newer binary. */
  checkForUpdate(deploymentKey?: string): Promise<RemotePackage | null>;
  download(update: RemotePackage, onProgress?: (progress: DownloadProgress) => void): Promise<LocalPackage>;
  /** Resolves with the mode used, before an `IMMEDIATE` update reloads the app. */
  install(update: LocalPackage, options?: InstallOptions): Promise<InstallMode>;
  /** The package being served; null while the app runs its store bundle. */
  getCurrentPackage(): Promise<LocalPackage | null>;
  /** An installed package waiting for a restart or a resume. */
  getPendingPackage(): Promise<LocalPackage | null>;
  /** Confirms the running package, so the next cold start does not roll it back. Call it on every start. */
  notifyApplicationReady(): Promise<void>;
  /** Reloads the app, applying a pending update. With `onlyIfUpdateIsPending`, does nothing without one. */
  restartApplication(onlyIfUpdateIsPending?: boolean): Promise<void>;
}

/** Codes the native side rejects with. */
export type CodePushErrorCode =
  'DOWNLOAD_FAILED' | 'INVALID_PACKAGE' | 'HASH_MISMATCH' | 'SIGNATURE_UNSUPPORTED' | 'NOT_STAGED' | 'INVALID_ARGUMENT';

export type DeploymentStatus = 'DeploymentSucceeded' | 'DeploymentFailed';

/** What the native side asks to be reported to the server. */
export interface StatusReport {
  /** Absent for a report of the binary version. */
  status?: DeploymentStatus;
  /** Present for a report of the binary version. */
  appVersion?: string;
  package?: Package;
  previousLabelOrAppVersion?: string;
  previousDeploymentKey?: string;
}

export interface NativeConfiguration {
  appVersion: string;
  clientUniqueId: string;
  serverUrl?: string;
  /** This platform's key. */
  deploymentKey?: string;
  publicKey?: string;
}

/** The native bridge. Internal: only the orchestrator calls it. */
export interface CodePushNativePlugin {
  getConfiguration(): Promise<NativeConfiguration>;
  getBinaryHash(): Promise<{ hash: string }>;
  getCurrentPackage(): Promise<{ package: LocalPackage | null }>;
  getPendingPackage(): Promise<{ package: LocalPackage | null }>;
  isFailedUpdate(options: { packageHash: string }): Promise<{ failed: boolean }>;
  downloadPackage(options: { package: RemotePackage }): Promise<{ package: LocalPackage }>;
  installPackage(options: {
    packageHash: string;
    installMode: InstallMode;
    minimumBackgroundDuration: number;
  }): Promise<void>;
  notifyApplicationReady(): Promise<{ statusReport: StatusReport | null }>;
  recordStatusReported(options: { statusReport: StatusReport }): Promise<void>;
  saveStatusReportForRetry(options: { statusReport: StatusReport }): Promise<void>;
  restartApplication(options: { onlyIfUpdateIsPending: boolean }): Promise<{ restarted: boolean }>;
  addListener(
    eventName: 'downloadProgress',
    listener: (progress: DownloadProgress) => void,
  ): Promise<PluginListenerHandle>;
}
