/**
 * The end-to-end scenario, the same on both platforms: the demo app against test/e2e/fake-server.mjs, through every
 * path the state machine has. Each step relaunches or kills the app the way a user would, and asserts on what the app
 * reports it serves, on what reached the server and on what the plugin left on disk. A platform brings a driver:
 *
 *   { name, deploymentKey, appVersion, repeatsColdStartLoads?, prepare(), install({ buildNumber, fresh }), launch(),
 *     terminate(), packageFile(packageHash, name) -> boolean }
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { startFakeServer } from './fake-server.mjs';

export const root = join(import.meta.dirname, '../..');
export const demo = join(root, 'demo');
export const port = Number(process.env.E2E_PORT ?? 3999);
export const appId = 'com.example.plugin';

export const sh = (file, args, options = {}) =>
  execFileSync(file, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options });
const step = (title) => console.log(`\n▶ ${title}`);

/** The demo's web build with the autopilot switched on, and per-release settings in its meta tags. */
function webBuild({ marker, confirm, sync, extraFiles = {} }) {
  const dir = mkdtempSync(join(tmpdir(), `codepush-web-${marker}-`));
  execFileSync('npx', ['vite', 'build', '--outDir', dir, '--emptyOutDir'], { cwd: demo, stdio: 'ignore' });
  const index = join(dir, 'index.html');
  const tags = [
    `<meta name="e2e-server" content="http://localhost:${port}" />`,
    `<meta name="e2e-confirm" content="${confirm ? 'yes' : 'no'}" />`,
    `<meta name="e2e-sync" content="${sync ? 'yes' : 'no'}" />`,
  ].join('\n    ');
  writeFileSync(
    index,
    readFileSync(index, 'utf8')
      .replace(/<meta name="build" content="[^"]*"/, `<meta name="build" content="${marker}"`)
      .replace('</head>', `    ${tags}\n  </head>`),
  );
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** Packs the plugin as npm would ship it, points the demo at the test server and syncs `platform`'s project. */
export function prepareDemo(platform) {
  sh('node', [join(demo, 'scripts/pack-plugin.mjs')]);
  sh('npm', ['install', '--no-audit', '--no-fund'], { cwd: demo, stdio: 'ignore' });
  const capacitorConfig = join(demo, 'capacitor.config.json');
  const config = JSON.parse(readFileSync(capacitorConfig, 'utf8'));
  config.plugins = {
    ...config.plugins,
    CodePush: {
      serverUrl: `http://localhost:${port}/`,
      iosDeploymentKey: 'e2e-ios',
      androidDeploymentKey: 'e2e-android',
      allowInsecureDownloads: true,
    },
  };
  writeFileSync(capacitorConfig, `${JSON.stringify(config, null, 2)}\n`);
  const store = webBuild({ marker: 'store', confirm: true, sync: true });
  sh('rm', ['-rf', join(demo, 'dist')]);
  sh('cp', ['-R', store, join(demo, 'dist')]);
  sh('npx', ['cap', 'sync', platform], { cwd: demo, stdio: 'ignore' });
}

async function waitFor(server, description, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = predicate(server.log);
    if (found) {
      return found;
    }
    await sleep(250);
  }
  console.error(JSON.stringify(server.log, null, 2));
  throw new Error(`Timed out waiting for: ${description}`);
}

function expectEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${what}: expected ${e}, got ${a}`);
  }
  console.log(`  ✓ ${what}: ${a}`);
}

const eventsSince = (log, index) => log.events.slice(index);
/**
 * The page loads since `index`, by marker. With `strict` off, the same page loading twice in a row counts once: Capacitor's
 * Android bridge loads the app twice on a cold start onto a stored server path (`Bridge.loadWebView` posts one load
 * from `setServerBasePath` and then makes its own), so the first one's script sometimes runs before the second one
 * replaces it. Both come from the same folder; the repeat is printed, never hidden.
 */
let strictLoads = true;
const loadedSince = (log, index) => {
  const all = eventsSince(log, index)
    .filter((event) => event.type === 'loaded')
    .map((event) => event.marker);
  const once = all.filter((marker, i) => marker !== all[i - 1]);
  if (once.length !== all.length) {
    console.log(`  ! the same page loaded twice in a row: ${JSON.stringify(all)}`);
  }
  return strictLoads ? all : once;
};

export async function runScenario(driver) {
  console.log(`Device: ${driver.name}`);
  const server = await startFakeServer({ port });
  const { deploymentKey, appVersion } = driver;
  strictLoads = !driver.repeatsColdStartLoads;
  try {
    step('Pack the plugin as npm would ship it, and build the demo on it');
    await driver.prepare();
    await driver.install({ buildNumber: 1, fresh: true });

    step('Fresh install on the store bundle');
    let mark = server.log.events.length;
    driver.launch();
    await waitFor(server, 'store sync', (log) => eventsSince(log, mark).find((e) => e.type === 'sync'));
    expectEqual(loadedSince(server.log, mark), ['store'], 'served');
    expectEqual(eventsSince(server.log, mark).find((e) => e.type === 'sync').status, 'UP_TO_DATE', 'sync');
    const binaryReport = await waitFor(server, 'binary report', (log) => log.reports.find((r) => r.kind === 'deploy'));
    expectEqual([binaryReport.app_version, binaryReport.label ?? null], [appVersion, null], 'binary report');
    expectEqual(server.log.queries[0].package_hash?.length, 64, 'store bundle hash sent with the check');

    step('v1 is offered, downloaded and installed for the next restart');
    server.release({
      label: 'v1',
      webDir: webBuild({ marker: 'v1', confirm: true, sync: true, extraFiles: { 'only-in-v1.txt': 'v1' } }),
    });
    driver.terminate();
    mark = server.log.events.length;
    driver.launch();
    const installed = await waitFor(server, 'v1 installed', (log) =>
      eventsSince(log, mark).find((e) => e.type === 'sync'),
    );
    expectEqual(installed.status, 'UPDATE_INSTALLED', 'sync');
    expectEqual(loadedSince(server.log, mark), ['store'], 'still served until a restart');
    expectEqual(
      server.log.reports.filter((r) => r.kind === 'download').map((r) => r.label),
      ['v1'],
      'download report',
    );

    step('A cold start serves v1 straight away, and v1 confirms');
    driver.terminate();
    mark = server.log.events.length;
    driver.launch();
    await waitFor(server, 'v1 confirmed', (log) => eventsSince(log, mark).find((e) => e.type === 'confirmed'));
    expectEqual(loadedSince(server.log, mark), ['v1'], 'served, with no store bundle load first');
    const v1Current = eventsSince(server.log, mark).find((e) => e.type === 'current');
    expectEqual([v1Current.label, v1Current.isFirstRun], ['v1', true], 'current package on its first run');
    const v1Report = await waitFor(server, 'v1 deploy report', (log) =>
      log.reports.find((r) => r.kind === 'deploy' && r.label === 'v1'),
    );
    expectEqual(
      [v1Report.status, v1Report.previous_label_or_app_version],
      ['DeploymentSucceeded', appVersion],
      'v1 report',
    );

    step('v2 is mandatory, applied immediately, and never confirms');
    server.release({ label: 'v2', mandatory: true, webDir: webBuild({ marker: 'v2', confirm: false, sync: false }) });
    driver.terminate();
    mark = server.log.events.length;
    driver.launch();
    await waitFor(server, 'v2 loaded', (log) => loadedSince(log, mark).includes('v2'));
    expectEqual(loadedSince(server.log, mark), ['v1', 'v2'], 'reloaded into v2');

    step('Killed during its trial, v2 is rolled back at the next cold start and reported');
    await sleep(1000);
    driver.terminate();
    mark = server.log.events.length;
    driver.launch();
    const afterRollback = await waitFor(server, 'sync after rollback', (log) =>
      eventsSince(log, mark).find((e) => e.type === 'sync'),
    );
    expectEqual(loadedSince(server.log, mark), ['v1'], 'served after the rollback');
    expectEqual(afterRollback.status, 'UP_TO_DATE', 'the failed v2 is not offered again');
    const failed = await waitFor(server, 'v2 failure report', (log) =>
      log.reports.find((r) => r.kind === 'deploy' && r.label === 'v2'),
    );
    expectEqual(failed.status, 'DeploymentFailed', 'v2 report');

    step('v3 arrives as a diff against v1, is checked against its hash and applied at the next restart');
    const v3 = server.release({
      label: 'v3',
      diffFrom: 'v1',
      webDir: webBuild({ marker: 'v3', confirm: true, sync: true, extraFiles: { 'only-in-v3.txt': 'v3' } }),
    });
    expectEqual(v3.diffSummary, { changed: ['index.html', 'only-in-v3.txt'], deleted: ['only-in-v1.txt'] }, 'the diff');
    driver.terminate();
    mark = server.log.events.length;
    driver.launch();
    const v3Installed = await waitFor(server, 'v3 installed', (log) =>
      eventsSince(log, mark).find((e) => e.type === 'sync'),
    );
    expectEqual(v3Installed.status, 'UPDATE_INSTALLED', 'sync');
    expectEqual(server.log.downloads.at(-1), 'v3-diff', 'downloaded the diff');
    driver.terminate();
    mark = server.log.events.length;
    driver.launch();
    await waitFor(server, 'v3 confirmed', (log) => eventsSince(log, mark).find((e) => e.type === 'confirmed'));
    expectEqual(loadedSince(server.log, mark), ['v3'], 'served');
    expectEqual(
      [driver.packageFile(v3.packageHash, 'only-in-v3.txt'), driver.packageFile(v3.packageHash, 'only-in-v1.txt')],
      [true, false],
      'on disk: the added file is there, the deleted one is gone',
    );
    const v3Report = await waitFor(server, 'v3 report', (log) =>
      log.reports.find((r) => r.kind === 'deploy' && r.label === 'v3'),
    );
    expectEqual(
      [v3Report.status, v3Report.previous_label_or_app_version, v3Report.previous_deployment_key],
      ['DeploymentSucceeded', 'v1', deploymentKey],
      'v3 report',
    );

    step('A new binary starts from the store bundle again');
    driver.terminate();
    await driver.install({ buildNumber: 2, fresh: false });
    mark = server.log.events.length;
    const reportsBefore = server.log.reports.length;
    driver.launch();
    await waitFor(server, 'store bundle after the upgrade', (log) => loadedSince(log, mark).length > 0);
    expectEqual(loadedSince(server.log, mark).slice(0, 1), ['store'], 'served after the upgrade');
    const binaryAgain = await waitFor(server, 'binary report after the upgrade', (log) =>
      log.reports.slice(reportsBefore).find((r) => r.kind === 'deploy' && !r.label),
    );
    expectEqual(
      [binaryAgain.previous_label_or_app_version, binaryAgain.previous_deployment_key],
      ['v3', deploymentKey],
      'the report names where the device came from',
    );

    console.log('\nAll end-to-end steps passed.');
  } finally {
    driver.terminate();
    server.close();
  }
}

export function main(driverFactory) {
  driverFactory()
    .then(runScenario)
    .catch((error) => {
      console.error(`\n✗ ${error.message}`);
      process.exitCode = 1;
    });
}
