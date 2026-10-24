import { describe, expect, it } from 'vitest';

import type { HttpRequester, HttpResponse } from '../../src/acquisition-client';
import { CodePushClient } from '../../src/code-push';
import { InstallMode, SyncStatus } from '../../src/definitions';
import type {
  CodePushNativePlugin,
  DownloadProgress,
  LocalPackage,
  NativeConfiguration,
  RemotePackage,
  StatusReport,
  SyncOptions,
} from '../../src/definitions';

const updateInfo = {
  is_available: true,
  target_binary_range: '2.3.4',
  description: 'fixes',
  label: 'v8',
  is_mandatory: false,
  package_hash: 'h8',
  package_size: 1234,
  download_url: 'https://cdn.example.com/v8.zip',
};

function localPackage(overrides: Partial<LocalPackage> = {}): LocalPackage {
  return {
    deploymentKey: 'key-1',
    description: 'fixes',
    label: 'v8',
    appVersion: '2.3.4',
    isMandatory: false,
    packageHash: 'h8',
    packageSize: 1234,
    failedInstall: false,
    isFirstRun: false,
    ...overrides,
  };
}

function nativeError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

class FakeNative implements CodePushNativePlugin {
  calls: [string, unknown?][] = [];
  configuration: NativeConfiguration = {
    appVersion: '2.3.4',
    clientUniqueId: 'client-9',
    serverUrl: 'https://updates.example.com',
    deploymentKey: 'key-1',
  };
  current: LocalPackage | null = null;
  pending: LocalPackage | null = null;
  binaryHash: string | Error = 'binary-hash';
  failedHashes = new Set<string>();
  statusReport: StatusReport | null = null;
  progress: DownloadProgress[] = [];
  downloadError?: Error;
  installError?: Error;
  listeners: ((progress: DownloadProgress) => void)[] = [];
  removedListeners = 0;

  async getConfiguration() {
    this.calls.push(['getConfiguration']);
    return this.configuration;
  }
  async getBinaryHash() {
    this.calls.push(['getBinaryHash']);
    if (this.binaryHash instanceof Error) {
      throw this.binaryHash;
    }
    return { hash: this.binaryHash };
  }
  async getCurrentPackage() {
    return { package: this.current };
  }
  async getPendingPackage() {
    return { package: this.pending };
  }
  async isFailedUpdate({ packageHash }: { packageHash: string }) {
    return { failed: this.failedHashes.has(packageHash) };
  }
  async downloadPackage({ package: update }: { package: RemotePackage }) {
    this.calls.push(['downloadPackage', update]);
    this.progress.forEach((event) => this.listeners.forEach((listener) => listener(event)));
    if (this.downloadError) {
      throw this.downloadError;
    }
    const local: LocalPackage & { downloadUrl?: string } = { ...update, isFirstRun: false };
    delete local.downloadUrl;
    return { package: local };
  }
  async installPackage(options: { packageHash: string; installMode: InstallMode; minimumBackgroundDuration: number }) {
    this.calls.push(['installPackage', options]);
    if (this.installError) {
      throw this.installError;
    }
  }
  async notifyApplicationReady() {
    this.calls.push(['notifyApplicationReady']);
    return { statusReport: this.statusReport };
  }
  async recordStatusReported({ statusReport }: { statusReport: StatusReport }) {
    this.calls.push(['recordStatusReported', statusReport]);
  }
  async saveStatusReportForRetry({ statusReport }: { statusReport: StatusReport }) {
    this.calls.push(['saveStatusReportForRetry', statusReport]);
  }
  async restartApplication(options: { onlyIfUpdateIsPending: boolean }) {
    this.calls.push(['restartApplication', options]);
    return { restarted: true };
  }
  async addListener(_eventName: 'downloadProgress', listener: (progress: DownloadProgress) => void) {
    this.listeners.push(listener);
    return {
      remove: async () => {
        this.listeners = this.listeners.filter((each) => each !== listener);
        this.removedListeners += 1;
      },
    };
  }

  called(name: string) {
    return this.calls.filter(([each]) => each === name).map(([, argument]) => argument);
  }
}

class FakeServer implements HttpRequester {
  sent: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  updateCheck: HttpResponse = { status: 200, body: JSON.stringify({ update_info: updateInfo }) };
  reports: HttpResponse = { status: 200, body: '' };

  async request(method: 'GET' | 'POST', url: string, body?: Record<string, unknown>) {
    this.sent.push({ method, url, body });
    return url.includes('update_check') ? this.updateCheck : this.reports;
  }

  updateChecks() {
    return this.sent.filter(({ url }) => url.includes('update_check')).map(({ url }) => new URL(url).searchParams);
  }

  reportsTo(endpoint: 'deploy' | 'download') {
    return this.sent.filter(({ url }) => url.endsWith(`report_status/${endpoint}`)).map(({ body }) => body);
  }
}

function setUp() {
  const native = new FakeNative();
  const server = new FakeServer();
  const client = new CodePushClient(native, server);
  return { native, server, client };
}

function syncOptions(overrides: Partial<SyncOptions> = {}): SyncOptions {
  return { onUpdateAvailable: () => true, ...overrides };
}

async function syncRecording(client: CodePushClient, options: SyncOptions) {
  const statuses: SyncStatus[] = [];
  const progress: DownloadProgress[] = [];
  const result = await client.sync(options, {
    onStatus: (status) => statuses.push(status),
    onProgress: (event) => progress.push(event),
  });
  return { result, statuses, progress };
}

describe('sync', () => {
  it('refuses to run without onUpdateAvailable, before touching the device or the server', async () => {
    const { native, server, client } = setUp();

    await expect(client.sync({} as SyncOptions)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(client.sync(undefined as unknown as SyncOptions)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(native.calls).toEqual([]);
    expect(server.sent).toEqual([]);
  });

  it('confirms the running package before checking, and stops when the app is up to date', async () => {
    const { native, server, client } = setUp();
    server.updateCheck = { status: 200, body: '{"update_info":{"is_available":false}}' };

    const { result, statuses } = await syncRecording(client, syncOptions());

    expect(result).toBe(SyncStatus.UP_TO_DATE);
    expect(statuses).toEqual([SyncStatus.CHECKING_FOR_UPDATE, SyncStatus.UP_TO_DATE]);
    expect(native.calls.map(([name]) => name).slice(0, 1)).toEqual(['notifyApplicationReady']);
    expect(native.called('downloadPackage')).toEqual([]);
  });

  it('answers IN_PROGRESS to a second sync while the first runs', async () => {
    const { client } = setUp();
    let answer!: (value: boolean) => void;
    const first = client.sync(syncOptions({ onUpdateAvailable: () => new Promise((resolve) => (answer = resolve)) }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const statuses: SyncStatus[] = [];
    const second = await client.sync(syncOptions(), { onStatus: (status) => statuses.push(status) });
    answer(false);

    expect(second).toBe(SyncStatus.IN_PROGRESS);
    expect(statuses).toEqual([SyncStatus.IN_PROGRESS]);
    expect(await first).toBe(SyncStatus.UPDATE_IGNORED);
  });

  it('downloads with progress and installs an accepted optional update on the next restart', async () => {
    const { native, client } = setUp();
    native.progress = [
      { totalBytes: 10, receivedBytes: 4 },
      { totalBytes: 10, receivedBytes: 10 },
    ];
    const asked: RemotePackage[] = [];

    const { result, statuses, progress } = await syncRecording(
      client,
      syncOptions({ onUpdateAvailable: (update) => (asked.push(update), true) }),
    );

    expect(result).toBe(SyncStatus.UPDATE_INSTALLED);
    expect(statuses).toEqual([
      SyncStatus.CHECKING_FOR_UPDATE,
      SyncStatus.AWAITING_USER_ACTION,
      SyncStatus.DOWNLOADING_PACKAGE,
      SyncStatus.INSTALLING_UPDATE,
      SyncStatus.UPDATE_INSTALLED,
    ]);
    expect(asked.map(({ label, failedInstall }) => ({ label, failedInstall }))).toEqual([
      { label: 'v8', failedInstall: false },
    ]);
    expect(progress).toEqual(native.progress);
    expect(native.removedListeners).toBe(1);
    expect(native.called('installPackage')).toEqual([
      { packageHash: 'h8', installMode: InstallMode.ON_NEXT_RESTART, minimumBackgroundDuration: 0 },
    ]);
  });

  it('ignores an optional update the user declined, without downloading it', async () => {
    const { native, client } = setUp();

    const { result, statuses } = await syncRecording(client, syncOptions({ onUpdateAvailable: async () => false }));

    expect(result).toBe(SyncStatus.UPDATE_IGNORED);
    expect(statuses.at(-1)).toBe(SyncStatus.UPDATE_IGNORED);
    expect(native.called('downloadPackage')).toEqual([]);
  });

  it('installs a mandatory update whatever the callback answers, with the mandatory install mode', async () => {
    const { native, server, client } = setUp();
    server.updateCheck = { status: 200, body: JSON.stringify({ update_info: { ...updateInfo, is_mandatory: true } }) };

    const { result } = await syncRecording(client, syncOptions({ onUpdateAvailable: () => false }));

    expect(result).toBe(SyncStatus.UPDATE_INSTALLED);
    expect(native.called('installPackage')).toEqual([
      { packageHash: 'h8', installMode: InstallMode.IMMEDIATE, minimumBackgroundDuration: 0 },
    ]);
  });

  it('passes the install options through, a null leaving the default in place', async () => {
    const { native, client } = setUp();

    await client.sync(
      syncOptions({
        installMode: InstallMode.ON_NEXT_RESUME,
        minimumBackgroundDuration: 30,
        mandatoryInstallMode: null as unknown as InstallMode,
      }),
    );

    expect(native.called('installPackage')).toEqual([
      { packageHash: 'h8', installMode: InstallMode.ON_NEXT_RESUME, minimumBackgroundDuration: 30 },
    ]);
  });

  it('skips an update rolled back before, unless told not to', async () => {
    const { native, client } = setUp();
    native.failedHashes.add('h8');
    let asked = 0;

    expect(await client.sync(syncOptions({ onUpdateAvailable: () => (asked++, true) }))).toBe(SyncStatus.UP_TO_DATE);
    expect(asked).toBe(0);

    expect(await client.sync(syncOptions({ ignoreFailedUpdates: false }))).toBe(SyncStatus.UPDATE_INSTALLED);
  });

  it('reports ERROR and rejects when the download fails, telling the server only about a bad package', async () => {
    for (const [code, reportsFailure] of [
      ['DOWNLOAD_FAILED', false],
      ['HASH_MISMATCH', true],
      ['INVALID_PACKAGE', true],
    ] as const) {
      const { native, server, client } = setUp();
      native.downloadError = nativeError(code);
      const statuses: SyncStatus[] = [];

      await expect(client.sync(syncOptions(), { onStatus: (status) => statuses.push(status) })).rejects.toMatchObject({
        code,
      });
      await client.reportsSettled();

      expect(statuses.at(-1)).toBe(SyncStatus.ERROR);
      expect(native.removedListeners).toBe(0);
      expect(server.reportsTo('deploy').map((body) => body?.status)).toEqual(
        reportsFailure ? ['DeploymentFailed'] : [],
      );
    }
  });

  it('lets a second sync run after an error', async () => {
    const { server, client } = setUp();
    server.updateCheck = { status: 500, body: 'down' };
    await expect(client.sync(syncOptions())).rejects.toThrow('500: down');

    server.updateCheck = { status: 200, body: '{}' };
    expect(await client.sync(syncOptions())).toBe(SyncStatus.UP_TO_DATE);
  });

  it('keeps checking when confirming the running package fails', async () => {
    const { native, client } = setUp();
    native.notifyApplicationReady = async () => {
      throw new Error('bridge gone');
    };

    expect(await client.sync(syncOptions())).toBe(SyncStatus.UPDATE_INSTALLED);
  });
});

describe('checkForUpdate', () => {
  it('asks about the store bundle by its hash when no package is installed', async () => {
    const { server, client } = setUp();

    await client.checkForUpdate();

    const [query] = server.updateChecks();
    expect(query.get('package_hash')).toBe('binary-hash');
    expect(query.get('label')).toBeNull();
    expect(query.get('app_version')).toBe('2.3.4');
  });

  it('asks about the pending package before the running one, always with the binary version', async () => {
    const { native, server, client } = setUp();
    native.current = localPackage({ packageHash: 'h6', label: 'v6', appVersion: '2.0.0' });
    await client.checkForUpdate();
    native.pending = localPackage({ packageHash: 'h7', label: 'v7' });
    await client.checkForUpdate();

    expect(
      server.updateChecks().map((query) => [query.get('label'), query.get('package_hash'), query.get('app_version')]),
    ).toEqual([
      ['v6', 'h6', '2.3.4'],
      ['v7', 'h7', '2.3.4'],
    ]);
  });

  it('asks without a hash when the store bundle cannot be hashed', async () => {
    const { native, server, client } = setUp();
    native.binaryHash = new Error('no assets');

    await client.checkForUpdate();

    expect(server.updateChecks()[0].has('package_hash')).toBe(false);
  });

  it('answers null for an update that needs a newer binary', async () => {
    const { server, client } = setUp();
    server.updateCheck = { status: 200, body: '{"update_info":{"update_app_version":true}}' };

    expect(await client.checkForUpdate()).toBeNull();
  });

  it('marks an update rolled back before and carries the key it was found with', async () => {
    const { native, server, client } = setUp();
    native.failedHashes.add('h8');

    const update = await client.checkForUpdate('other-key');

    expect(update).toMatchObject({
      failedInstall: true,
      deploymentKey: 'other-key',
      downloadUrl: updateInfo.download_url,
    });
    expect(server.updateChecks()[0].get('deployment_key')).toBe('other-key');
  });
});

describe('configuration', () => {
  it('lets configure() override the server and key, and a call override both', async () => {
    const { server, client } = setUp();
    client.configure({ serverUrl: 'https://flag.example.com/', deploymentKey: 'flag-key' });
    await client.checkForUpdate();
    await client.checkForUpdate('call-key');

    expect(server.sent.map(({ url }) => [new URL(url).host, new URL(url).searchParams.get('deployment_key')])).toEqual([
      ['flag.example.com', 'flag-key'],
      ['flag.example.com', 'call-key'],
    ]);
  });

  it('refuses without a server URL or a deployment key', async () => {
    for (const missing of ['serverUrl', 'deploymentKey'] as const) {
      const { native, server, client } = setUp();
      native.configuration = { ...native.configuration, [missing]: undefined };

      await expect(client.checkForUpdate()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(server.sent).toEqual([]);
    }
  });

  it('reads the native configuration once', async () => {
    const { native, client } = setUp();
    await client.checkForUpdate();
    await client.checkForUpdate();

    expect(native.called('getConfiguration')).toHaveLength(1);
  });
});

describe('download and install', () => {
  it('reports a finished download to the server', async () => {
    const { server, client } = setUp();
    const update = await client.checkForUpdate();
    if (!update) {
      throw new Error('the fake server offers an update');
    }

    await client.download(update);
    await client.reportsSettled();

    expect(server.reportsTo('download')).toEqual([
      { client_unique_id: 'client-9', deployment_key: 'key-1', label: 'v8' },
    ]);
  });

  it('reports a failed install as DeploymentFailed and rethrows', async () => {
    const { native, server, client } = setUp();
    native.installError = nativeError('NOT_STAGED');

    await expect(client.install(localPackage())).rejects.toMatchObject({ code: 'NOT_STAGED' });
    await client.reportsSettled();

    expect(server.reportsTo('deploy')).toEqual([
      expect.objectContaining({ label: 'v8', status: 'DeploymentFailed', app_version: '2.3.4' }),
    ]);
  });

  it('resolves with the mode it used', async () => {
    const { client } = setUp();

    expect(await client.install(localPackage())).toBe(InstallMode.ON_NEXT_RESTART);
    expect(await client.install(localPackage({ isMandatory: true }))).toBe(InstallMode.IMMEDIATE);
  });
});

describe('notifyApplicationReady and status reports', () => {
  it('sends nothing when the device has nothing to report', async () => {
    const { server, client } = setUp();

    await client.notifyApplicationReady();
    await client.reportsSettled();

    expect(server.sent).toEqual([]);
  });

  it("sends a package's report under its own key and records it", async () => {
    const { native, server, client } = setUp();
    native.statusReport = {
      status: 'DeploymentSucceeded',
      package: localPackage({ deploymentKey: 'pkg-key', appVersion: '2.3.0' }),
      previousLabelOrAppVersion: 'v7',
      previousDeploymentKey: 'key-1',
    };

    await client.notifyApplicationReady();
    await client.reportsSettled();

    expect(server.reportsTo('deploy')).toEqual([
      {
        app_version: '2.3.0',
        deployment_key: 'pkg-key',
        client_unique_id: 'client-9',
        label: 'v8',
        status: 'DeploymentSucceeded',
        previous_label_or_app_version: 'v7',
        previous_deployment_key: 'key-1',
      },
    ]);
    expect(native.called('recordStatusReported')).toEqual([native.statusReport]);
    expect(native.called('saveStatusReportForRetry')).toEqual([]);
  });

  it('sends a binary report without a label or status', async () => {
    const { native, server, client } = setUp();
    native.statusReport = { appVersion: '2.3.4', previousLabelOrAppVersion: '2.3.3' };

    await client.notifyApplicationReady();
    await client.reportsSettled();

    expect(server.reportsTo('deploy')).toEqual([
      {
        app_version: '2.3.4',
        deployment_key: 'key-1',
        client_unique_id: 'client-9',
        previous_label_or_app_version: '2.3.3',
      },
    ]);
  });

  it('keeps a report the server did not take for a retry, and still resolves', async () => {
    const { native, server, client } = setUp();
    server.reports = { status: 503, body: 'busy' };
    native.statusReport = { status: 'DeploymentFailed', package: localPackage() };

    await expect(client.notifyApplicationReady()).resolves.toBeUndefined();
    await client.reportsSettled();

    expect(native.called('saveStatusReportForRetry')).toEqual([native.statusReport]);
    expect(native.called('recordStatusReported')).toEqual([]);
  });
});

describe('packages and restart', () => {
  it('passes the current and pending packages through', async () => {
    const { native, client } = setUp();
    native.current = localPackage({ label: 'v6' });

    expect(await client.getCurrentPackage()).toEqual(native.current);
    expect(await client.getPendingPackage()).toBeNull();
  });

  it('restarts unconditionally by default', async () => {
    const { native, client } = setUp();
    await client.restartApplication();
    await client.restartApplication(true);

    expect(native.called('restartApplication')).toEqual([
      { onlyIfUpdateIsPending: false },
      { onlyIfUpdateIsPending: true },
    ]);
  });
});
