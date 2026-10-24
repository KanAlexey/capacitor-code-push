import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { changelog, commitOf, notesOf } from '../../scripts/release.mjs';

const root = join(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

describe('scripts/release.mjs', () => {
  it('finds a changelog block for the version in package.json, so its release is never empty', () => {
    expect(notesOf(changelog(root), pkg.version)).toBeTruthy();
  });

  it('takes the lines under one heading, and nothing for a version that has none', () => {
    const md = '# Changelog\n\n## Unreleased\n\n## v1.3.1\n\n- one\n\n## v1.3.0\n\n- two\n';

    expect(notesOf(md, '1.3.1')).toBe('- one');
    expect(notesOf(md, '1.3.0')).toBe('- two');
    expect(notesOf(md, '9.9.9')).toBeNull();
    expect(notesOf('## v1.0.10\n\n- x\n', '1.0.1')).toBeNull();
  });

  it('dates a version to the first commit on the first-parent line that carries it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-'));
    try {
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
          {
            cwd: dir,
            encoding: 'utf8',
          },
        ).trim();
      git('init', '-q', '-b', 'master');
      const commit = (version: string, message: string) => {
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
        writeFileSync(join(dir, 'note'), message);
        git('add', '-A');
        git('commit', '-q', '-m', message);
        return git('rev-parse', 'HEAD');
      };
      commit('1.0.0', 'first');
      const bump = commit('1.1.0', 'bump');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.1.0', description: 'later' }));
      git('commit', '-q', '-am', 'later');

      expect(commitOf('1.1.0', dir)).toBe(bump);
      expect(commitOf('2.0.0', dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
