import { CapacitorHttp } from '@capacitor/core';
import { CodePush, SyncStatus } from 'capacitor-code-push';

const log = (line) => {
  const output = document.getElementById('log');
  output.textContent = `${new Date().toLocaleTimeString()} ${line}\n${output.textContent}`;
};
const run = (name, work) => async () => {
  try {
    log(`${name}: ${JSON.stringify(await work())}`);
  } catch (error) {
    log(`${name} failed: ${error.code ?? ''} ${error.message}`);
  }
};

CodePush.configure({ debug: true });
document.getElementById('build').textContent = document.querySelector('meta[name="build"]').content;

window.notifyReady = run('notifyApplicationReady', () => CodePush.notifyApplicationReady());
window.current = run('getCurrentPackage', () => CodePush.getCurrentPackage());
window.pending = run('getPendingPackage', () => CodePush.getPendingPackage());
window.check = run('checkForUpdate', () => CodePush.checkForUpdate());
window.sync = run('sync', async () =>
  SyncStatus[
    await CodePush.sync(
      { onUpdateAvailable: (update) => window.confirm(`Install ${update.label}?`) },
      { onStatus: (status) => log(`status ${SyncStatus[status]}`), onProgress: (p) => log(`${p.receivedBytes}/${p.totalBytes}`) },
    )
  ],
);
window.restart = run('restartApplication', () => CodePush.restartApplication());

/**
 * End-to-end autopilot, off unless the build carries an `e2e-server` meta tag (test/e2e injects it). On every page
 * load it reports what is served, confirms the package when told to, and syncs when told to, posting each step to the
 * test server through CapacitorHttp (native, so neither CORS nor mixed content stands in the way).
 */

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content;
const e2eServer = meta('e2e-server');

if (e2eServer) {
  const marker = meta('build');
  const post = (event) =>
    CapacitorHttp.request({
      method: 'POST',
      url: `${e2eServer}/__event`,
      headers: { 'Content-Type': 'application/json' },
      data: { marker, at: Date.now(), ...event },
    }).catch(() => undefined);

  (async () => {
    await post({ type: 'loaded' });
    const current = await CodePush.getCurrentPackage();
    await post({ type: 'current', label: current?.label ?? null, isFirstRun: current?.isFirstRun ?? null });
    if (meta('e2e-confirm') === 'yes') {
      await CodePush.notifyApplicationReady();
      await post({ type: 'confirmed' });
    }
    if (meta('e2e-sync') === 'yes') {
      try {
        const status = await CodePush.sync(
          { onUpdateAvailable: () => true },
          { onStatus: (s) => post({ type: 'status', status: SyncStatus[s] }) },
        );
        await post({ type: 'sync', status: SyncStatus[status] });
      } catch (error) {
        await post({ type: 'sync-error', code: error.code ?? null, message: error.message });
      }
    }
  })();
}
