/**
 * The end-to-end scenario (scenario.mjs) on an Android EMULATOR:
 *
 *   node test/e2e/run-android.mjs   (ANDROID_SERIAL=emulator-5554 picks a running one; ANDROID_AVD=<name> starts one)
 *
 * Only an emulator is ever used, never a phone on the cable: the scenario uninstalls and reinstalls the demo app.
 * `adb reverse` gives the emulator the computer's localhost, so the app reaches the test server as on iOS.
 * The demo builds with JDK 21 (JAVA_HOME, else Android Studio's runtime).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { appId, demo, main, port, prepareDemo, sh } from './scenario.mjs';

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library/Android/sdk');
const adbPath = join(sdk, 'platform-tools/adb');

/** A JDK 21, which Capacitor 8's Gradle toolchain asks for: JAVA_HOME when it is one, else Android Studio's runtime. */
function javaHome() {
  const isJdk21 = (home) => {
    try {
      return /JAVA_VERSION="21[".]/.test(readFileSync(join(home, 'release'), 'utf8'));
    } catch {
      return false;
    }
  };
  const candidates = [process.env.JAVA_HOME, '/Applications/Android Studio.app/Contents/jbr/Contents/Home'];
  const home = candidates.find((candidate) => candidate && existsSync(candidate) && isJdk21(candidate));
  if (!home) {
    throw new Error('No JDK 21 found: set JAVA_HOME to one.');
  }
  return home;
}

const emulators = () =>
  sh(adbPath, ['devices'])
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([serial, state]) => serial.startsWith('emulator-') && state === 'device')
    .map(([serial]) => serial);

async function emulatorSerial() {
  const wanted = process.env.ANDROID_SERIAL;
  if (wanted) {
    if (!wanted.startsWith('emulator-')) {
      throw new Error(`ANDROID_SERIAL=${wanted} is not an emulator; this scenario reinstalls the app.`);
    }
    return wanted;
  }
  const running = emulators();
  if (running.length) {
    return running[0];
  }
  const avd = process.env.ANDROID_AVD ?? sh(join(sdk, 'emulator/emulator'), ['-list-avds']).trim().split('\n')[0];
  if (!avd) {
    throw new Error('No emulator is running and no AVD exists to start one.');
  }
  console.log(`Starting the emulator ${avd}`);
  spawn(join(sdk, 'emulator/emulator'), ['-avd', avd, '-no-snapshot-save', '-no-boot-anim', '-no-audio'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  for (let i = 0; i < 180; i++) {
    const [serial] = emulators();
    if (serial && sh(adbPath, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).trim() === '1') {
      return serial;
    }
    await sleep(1000);
  }
  throw new Error(`The emulator ${avd} did not boot in three minutes.`);
}

main(async () => {
  const serial = await emulatorSerial();
  const adb = (...args) => sh(adbPath, ['-s', serial, ...args]);
  const model = adb('shell', 'getprop', 'ro.product.model').trim();
  const release = adb('shell', 'getprop', 'ro.build.version.release').trim();

  return {
    name: `${model}, Android ${release} (${serial})`,
    deploymentKey: 'e2e-android',
    // Capacitor's own double load of a stored server path (see loadedSince in scenario.mjs)
    repeatsColdStartLoads: true,
    // the demo's versionName
    appVersion: '1.0',
    prepare: () => prepareDemo('android'),
    install({ buildNumber, fresh }) {
      const jdk = javaHome();
      sh(
        './gradlew',
        ['-q', 'assembleDebug', `-PdemoVersionCode=${buildNumber}`, `-Dorg.gradle.java.installations.paths=${jdk}`],
        {
          cwd: join(demo, 'android'),
          env: { ...process.env, JAVA_HOME: jdk },
          stdio: ['ignore', 'ignore', 'inherit'],
        },
      );
      adb('reverse', `tcp:${port}`, `tcp:${port}`);
      if (fresh) {
        try {
          adb('uninstall', appId);
        } catch {
          // Not installed.
        }
      }
      adb('install', '-r', join(demo, 'android/app/build/outputs/apk/debug/app-debug.apk'));
    },
    launch: () => adb('shell', 'am', 'start', '-W', '-n', `${appId}/.MainActivity`),
    terminate: () => adb('shell', 'am', 'force-stop', appId),
    packageFile(packageHash, name) {
      try {
        adb('shell', 'run-as', appId, 'ls', `files/capacitor-codepush/packages/${packageHash}/${name}`);
        return true;
      } catch {
        return false;
      }
    },
  };
});
