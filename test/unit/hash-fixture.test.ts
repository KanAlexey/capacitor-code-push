import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { referencePackageHash } from './reference-hash';

const fixture = join(__dirname, '../fixtures/hash');
const temporary: string[] = [];

function release(files: Record<string, string>): string {
  const root = join(mkdtempSync(join(tmpdir(), 'cp-hash-')), 'www');
  temporary.push(dirname(root));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

afterEach(() => {
  temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('the package hash', () => {
  it('of the shared fixture is the value the native suites are checked against', () => {
    const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8')) as { packageHash: string };

    expect(referencePackageHash(join(fixture, 'release/www'))).toBe(expected.packageHash);
  });

  it('skips .DS_Store at any depth', () => {
    const plain = release({ 'index.html': 'a', 'js/main.js': 'b' });
    const withJunk = release({ 'index.html': 'a', 'js/main.js': 'b', '.DS_Store': 'x', 'js/.DS_Store': 'y' });

    expect(referencePackageHash(withJunk)).toBe(referencePackageHash(plain));
  });

  it('hashes .codepushrelease and a nested __MACOSX, which the Revopush CLI does not skip', () => {
    const plain = release({ 'index.html': 'a' });

    expect(referencePackageHash(release({ 'index.html': 'a', '.codepushrelease': 'jwt' }))).not.toBe(
      referencePackageHash(plain),
    );
    expect(referencePackageHash(release({ 'index.html': 'a', '__MACOSX/x': 'y' }))).not.toBe(
      referencePackageHash(plain),
    );
  });

  it('depends on the release folder name, which is part of every path', () => {
    const files = { 'index.html': 'a' };
    const www = release(files);
    const publicRoot = join(dirname(www), 'public');
    mkdirSync(publicRoot);
    writeFileSync(join(publicRoot, 'index.html'), 'a');

    expect(referencePackageHash(publicRoot)).not.toBe(referencePackageHash(www));
  });
});
