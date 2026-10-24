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
