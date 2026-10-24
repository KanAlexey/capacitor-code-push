import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** The methods of `CodePushNativePlugin` in definitions.ts, listeners aside. */
function typescriptMethods(): string[] {
  const source = read('src/definitions.ts');
  const body = source.slice(source.indexOf('export interface CodePushNativePlugin {'));
  const block = body.slice(0, body.indexOf('\n}\n'));
  return [...block.matchAll(/^ {2}(\w+)\(/gm)].map(([, name]) => name).filter((name) => name !== 'addListener');
}

function swiftMethods(): string[] {
  const source = read('ios/Sources/CodePushPlugin/CodePushPlugin.swift');
  return [...source.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map(([, name]) => name);
}

function swiftImplementations(): string[] {
  const source = read('ios/Sources/CodePushPlugin/CodePushPlugin.swift');
  return [...source.matchAll(/@objc func (\w+)\(_ call: CAPPluginCall\)/g)].map(([, name]) => name);
}

function kotlinMethods(): string[] {
  const source = read('android/src/main/kotlin/io/github/kanalexey/codepush/CodePushPlugin.kt');
  return [...source.matchAll(/@PluginMethod\s+fun (\w+)\(/g)].map(([, name]) => name);
}

function webMethods(): string[] {
  const source = read('src/web.ts');
  return [...source.matchAll(/^ {2}async (\w+)\(/gm)].map(([, name]) => name);
}

describe('the native bridge', () => {
  const expected = typescriptMethods().sort();

  it('declares at least the calls the orchestrator makes', () => {
    expect(expected).toEqual([
      'downloadPackage',
      'getBinaryHash',
      'getConfiguration',
      'getCurrentPackage',
      'getPendingPackage',
      'installPackage',
      'isFailedUpdate',
      'notifyApplicationReady',
      'recordStatusReported',
      'restartApplication',
      'saveStatusReportForRetry',
    ]);
  });

  it('is registered and implemented the same on iOS', () => {
    expect(swiftMethods().sort()).toEqual(expected);
    expect(swiftImplementations().sort()).toEqual(expected);
  });

  it('is implemented the same on Android', () => {
    expect(kotlinMethods().sort()).toEqual(expected);
  });

  it('is answered the same by the web stub', () => {
    expect(webMethods().sort()).toEqual(expected);
  });
});

describe('the package manifest', () => {
  const manifest = JSON.parse(read('package.json')) as { files: string[] };

  it('ships what an app builds from, and no test fixtures', () => {
    expect(manifest.files).toEqual(
      expect.arrayContaining(['android/src/main/', 'android/build.gradle', 'dist/', 'ios/Sources', 'Package.swift']),
    );
    // Package.swift names the test target's folder, so SwiftPM refuses the package if ios/Tests is missing.
    expect(manifest.files).toContain('ios/Tests');
    expect(manifest.files.some((path) => path.startsWith('test'))).toBe(false);
  });
});
