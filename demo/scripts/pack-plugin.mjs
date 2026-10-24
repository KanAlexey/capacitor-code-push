/* eslint-disable no-console */
// Puts the plugin THIS checkout holds into demo/.plugin the way npm would ship it: built, packed, unpacked. The demo depends
// on that folder (`file:.plugin`), so it runs exactly the files package.json publishes, and a file missing from `files`
// breaks the demo instead of the first app that installs the package.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const demo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(demo, '..');
const out = join(demo, '.plugin');

execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: root, encoding: 'utf8' })
  .trim()
  .split('\n')
  .pop();
execFileSync('tar', ['-xzf', join(out, tarball), '-C', out, '--strip-components=1']);
rmSync(join(out, tarball));
console.log(`packed the plugin into ${out}`);
