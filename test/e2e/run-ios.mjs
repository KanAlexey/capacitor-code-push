/**
 * The end-to-end scenario (scenario.mjs) on an iOS simulator:
 *
 *   node test/e2e/run-ios.mjs            (IOS_SIMULATOR=<name or udid> picks the device)
 *
 * The simulator shares the Mac's network, so the app reaches the test server at localhost.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appId, demo, main, prepareDemo, root, sh } from './scenario.mjs';

main(async () => {
  const udid = sh('node', [join(root, 'test/ios/simulator.mjs'), '--udid']).trim();
  const device = Object.values(JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', '-j'])).devices)
    .flat()
    .find((each) => each.udid === udid);
  const derivedData = process.env.E2E_DERIVED_DATA ?? mkdtempSync(join(tmpdir(), 'codepush-e2e-dd-'));
  const simctl = (...args) => sh('xcrun', ['simctl', ...args]);

  return {
    name: `${device.name} (${udid})`,
    deploymentKey: 'e2e-ios',
    // the demo's MARKETING_VERSION
    appVersion: '1.0',
    prepare: () => prepareDemo('ios'),
    install({ buildNumber, fresh }) {
      sh(
        'xcodebuild',
        [
          '-project',
          join(demo, 'ios/App/App.xcodeproj'),
          '-scheme',
          'App',
          '-configuration',
          'Debug',
          '-sdk',
          'iphonesimulator',
          '-destination',
          'generic/platform=iOS Simulator',
          '-derivedDataPath',
          derivedData,
          `CURRENT_PROJECT_VERSION=${buildNumber}`,
          'CODE_SIGNING_ALLOWED=NO',
          'build',
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      );
      if (device.state !== 'Booted') {
        simctl('boot', udid);
        device.state = 'Booted';
      }
      if (fresh) {
        try {
          simctl('uninstall', udid, appId);
        } catch {
          // Not installed.
        }
      }
      simctl('install', udid, join(derivedData, 'Build/Products/Debug-iphonesimulator/App.app'));
    },
    launch: () => simctl('launch', udid, appId),
    terminate() {
      try {
        simctl('terminate', udid, appId);
      } catch {
        // Not running.
      }
    },
    packageFile(packageHash, name) {
      const container = simctl('get_app_container', udid, appId, 'data').trim();
      return existsSync(join(container, 'Library/NoCloud/capacitor-codepush/packages', packageHash, name));
    },
  };
});
