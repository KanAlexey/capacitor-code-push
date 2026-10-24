import { AcquisitionClient } from './acquisition-client';
import type { HttpRequester, QueryPackage } from './acquisition-client';
import { InstallMode, SyncStatus } from './definitions';
import type {
  CodePushConfig,
  CodePushNativePlugin,
  CodePushPlugin,
  DownloadProgress,
  InstallOptions,
  LocalPackage,
  NativeConfiguration,
  RemotePackage,
  StatusReport,
  SyncCallbacks,
  SyncOptions,
} from './definitions';

/** An error this module raises itself, with the same `code` shape the native side rejects with. */
export class CodePushError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CodePushError';
  }
}

const DEFAULT_INSTALL_OPTIONS: Required<InstallOptions> = {
  installMode: InstallMode.ON_NEXT_RESTART,
  mandatoryInstallMode: InstallMode.IMMEDIATE,
  minimumBackgroundDuration: 0,
};

/** Native rejections that mean the package itself is bad, which the server is told about. */
const PACKAGE_FAULTS = new Set(['INVALID_PACKAGE', 'HASH_MISMATCH', 'SIGNATURE_UNSUPPORTED']);

/** Defaults filled in where the caller left a field undefined or null, as cordova-plugin-code-push did. */
function withDefaults<T extends object>(defaults: Required<T>, given: Partial<T> | undefined): Required<T> {
  const result = { ...defaults };
  for (const key of Object.keys(given ?? {}) as (keyof T)[]) {
    const value = given?.[key];
    if (value !== undefined && value !== null) {
      result[key] = value as Required<T>[keyof T];
    }
  }
  return result;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export class CodePushClient implements CodePushPlugin {
  private runtime: CodePushConfig = {};
  private nativeConfiguration?: Promise<NativeConfiguration>;
  private syncInProgress = false;
  private reporting: Promise<void> = Promise.resolve();

  constructor(
    private readonly native: CodePushNativePlugin,
    private readonly http: HttpRequester,
  ) {}

  configure(config: CodePushConfig): void {
    this.runtime = { ...this.runtime, ...config };
  }

  async sync(options: SyncOptions, callbacks: SyncCallbacks = {}): Promise<SyncStatus> {
    if (typeof options?.onUpdateAvailable !== 'function') {
      throw new CodePushError('INVALID_ARGUMENT', 'sync() needs options.onUpdateAvailable.');
    }
    const report = (status: SyncStatus) => callbacks.onStatus?.(status);
    if (this.syncInProgress) {
      this.log('Sync already in progress.');
      report(SyncStatus.IN_PROGRESS);
      return SyncStatus.IN_PROGRESS;
    }
    this.syncInProgress = true;
    try {
      const status = await this.syncInternal(options, callbacks, report);
      report(status);
      return status;
    } catch (error) {
      this.log(`An error occurred during sync: ${String(error)}`);
      report(SyncStatus.ERROR);
      throw error;
    } finally {
      this.syncInProgress = false;
    }
  }

  async checkForUpdate(deploymentKey?: string): Promise<RemotePackage | null> {
    const { client, deploymentKey: key, configuration } = await this.acquisition(deploymentKey);
    const result = await client.queryUpdate(await this.queryPackage(configuration));
    if (result.kind === 'binaryUpdateRequired') {
      this.log('An update is available, but it is targeting a newer binary version than you are currently running.');
      return null;
    }
    if (result.kind === 'upToDate') {
      this.log('App is up to date.');
      return null;
    }
    const { failed } = await this.native.isFailedUpdate({ packageHash: result.package.packageHash });
    const update: RemotePackage = { ...result.package, deploymentKey: key, failedInstall: failed };
    this.log(`An update is available. ${JSON.stringify(update)}`);
    return update;
  }

  async download(update: RemotePackage, onProgress?: (progress: DownloadProgress) => void): Promise<LocalPackage> {
    const listener = onProgress ? await this.native.addListener('downloadProgress', onProgress) : undefined;
    try {
      const { package: local } = await this.native.downloadPackage({ package: update });
      this.background(async () => {
        const { client } = await this.acquisition(local.deploymentKey);
        await client.reportDownload(local);
      });
      return local;
    } catch (error) {
      if (PACKAGE_FAULTS.has(errorCode(error) ?? '')) {
        this.reportDeploymentFailed(update);
      }
      throw error;
    } finally {
      await listener?.remove();
    }
  }

  async install(update: LocalPackage, options?: InstallOptions): Promise<InstallMode> {
    const resolved = withDefaults(DEFAULT_INSTALL_OPTIONS, options);
    const installMode = update.isMandatory ? resolved.mandatoryInstallMode : resolved.installMode;
    try {
      await this.native.installPackage({
        packageHash: update.packageHash,
        installMode,
        minimumBackgroundDuration: resolved.minimumBackgroundDuration,
      });
    } catch (error) {
      this.reportDeploymentFailed(update);
      throw error;
    }
    return installMode;
  }

  async getCurrentPackage(): Promise<LocalPackage | null> {
    return (await this.native.getCurrentPackage()).package;
  }

  async getPendingPackage(): Promise<LocalPackage | null> {
    return (await this.native.getPendingPackage()).package;
  }

  async notifyApplicationReady(): Promise<void> {
    const { statusReport } = await this.native.notifyApplicationReady();
    if (statusReport) {
      this.background(() => this.sendStatusReport(statusReport));
    }
  }

  async restartApplication(onlyIfUpdateIsPending = false): Promise<void> {
    await this.native.restartApplication({ onlyIfUpdateIsPending });
  }

  /** @internal Resolves once every report started so far has been sent or given up on. */
  reportsSettled(): Promise<void> {
    return this.reporting;
  }

  private async syncInternal(
    options: SyncOptions,
    callbacks: SyncCallbacks,
    report: (status: SyncStatus) => void,
  ): Promise<SyncStatus> {
    const resolved = withDefaults(DEFAULT_INSTALL_OPTIONS, options);
    const ignoreFailedUpdates = options.ignoreFailedUpdates ?? true;

    // As in cordova-plugin-code-push: confirming the running package must not stop the update check.
    await this.notifyApplicationReady().catch((error) => this.log(`notifyApplicationReady failed: ${String(error)}`));

    report(SyncStatus.CHECKING_FOR_UPDATE);
    const update = await this.checkForUpdate(options.deploymentKey ?? undefined);
    if (!update) {
      return SyncStatus.UP_TO_DATE;
    }
    if (update.failedInstall && ignoreFailedUpdates) {
      this.log('An update is available, but it is being ignored due to having been previously rolled back.');
      return SyncStatus.UP_TO_DATE;
    }

    report(SyncStatus.AWAITING_USER_ACTION);
    const accepted = await options.onUpdateAvailable(update);
    if (!accepted && !update.isMandatory) {
      this.log('User cancelled the update.');
      return SyncStatus.UPDATE_IGNORED;
    }

    report(SyncStatus.DOWNLOADING_PACKAGE);
    const local = await this.download(update, callbacks.onProgress);
    report(SyncStatus.INSTALLING_UPDATE);
    await this.install(local, resolved);
    return SyncStatus.UPDATE_INSTALLED;
  }

  /** The package the server is asked about: the latest installed one, or the store bundle. */
  private async queryPackage(configuration: NativeConfiguration): Promise<QueryPackage> {
    const latest = (await this.native.getPendingPackage()).package ?? (await this.native.getCurrentPackage()).package;
    if (latest) {
      return { appVersion: configuration.appVersion, packageHash: latest.packageHash, label: latest.label };
    }
    try {
      const { hash } = await this.native.getBinaryHash();
      return { appVersion: configuration.appVersion, packageHash: hash };
    } catch (error) {
      this.log(`Could not get binary hash. ${String(error)}`);
      return { appVersion: configuration.appVersion };
    }
  }

  private async sendStatusReport(statusReport: StatusReport): Promise<void> {
    try {
      const { client } = await this.acquisition(statusReport.package?.deploymentKey);
      if (statusReport.package) {
        await client.reportDeploy(
          statusReport.package,
          statusReport.status,
          statusReport.previousLabelOrAppVersion,
          statusReport.previousDeploymentKey,
        );
      } else {
        await client.reportDeploy(
          undefined,
          undefined,
          statusReport.previousLabelOrAppVersion,
          statusReport.previousDeploymentKey,
        );
      }
      this.log(`Reported status: ${JSON.stringify(statusReport)}`);
      await this.native.recordStatusReported({ statusReport });
    } catch (error) {
      this.log(`An error occurred while reporting status: ${JSON.stringify(statusReport)} ${String(error)}`);
      await this.native.saveStatusReportForRetry({ statusReport });
    }
  }

  private reportDeploymentFailed(update: RemotePackage | LocalPackage): void {
    this.background(async () => {
      const { client } = await this.acquisition(update.deploymentKey);
      await client.reportDeploy(update, 'DeploymentFailed');
    });
  }

  private async acquisition(deploymentKey?: string): Promise<{
    client: AcquisitionClient;
    deploymentKey: string;
    configuration: NativeConfiguration;
  }> {
    this.nativeConfiguration ??= this.native.getConfiguration();
    const configuration = await this.nativeConfiguration.catch((error) => {
      this.nativeConfiguration = undefined;
      throw error;
    });
    const serverUrl = this.runtime.serverUrl ?? configuration.serverUrl;
    if (!serverUrl) {
      throw new CodePushError('INVALID_ARGUMENT', 'No server URL: set plugins.CodePush.serverUrl or call configure().');
    }
    const key = deploymentKey || this.runtime.deploymentKey || configuration.deploymentKey;
    if (!key) {
      throw new CodePushError(
        'INVALID_ARGUMENT',
        'No deployment key: set plugins.CodePush.iosDeploymentKey / androidDeploymentKey, call configure(), or pass one.',
      );
    }
    const client = new AcquisitionClient(this.http, {
      serverUrl,
      deploymentKey: key,
      appVersion: configuration.appVersion,
      clientUniqueId: configuration.clientUniqueId,
      ignoreAppVersion: false,
    });
    return { client, deploymentKey: key, configuration };
  }

  /** Runs reporting work that must never fail the caller, and keeps it observable for tests. */
  private background(work: () => Promise<void>): void {
    const run = this.reporting.then(work).catch((error) => this.log(`Background report failed: ${String(error)}`));
    this.reporting = run;
  }

  private log(message: string): void {
    if (this.runtime.debug) {
      console.log(`[CodePush] ${message}`);
    }
  }
}
