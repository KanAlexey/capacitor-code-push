/**
 * A CodePush server small enough to read: the three acquisition endpoints as Revopush answers them, packages zipped
 * the way the Revopush CLI zips a release folder (entries `www/...`, no directory entries), diffs against an earlier
 * release, and a log of every query, report and autopilot event for the end-to-end runner to assert on.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { referencePackageHash } from '../unit/reference-hash.ts';

function files(root) {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Zips `releaseRoot` (a folder named `www`) with paths relative to its parent, files only, as the CLI does. */
function zipRelease(releaseRoot, zipPath, only) {
  const base = dirname(releaseRoot);
  const entries = (only ?? files(releaseRoot)).map((file) => relative(base, file));
  rmSync(zipPath, { force: true });
  execFileSync('zip', ['-q', '-X', zipPath, ...entries], { cwd: base });
}

export function startFakeServer({ port }) {
  const work = mkdtempSync(join(tmpdir(), 'codepush-e2e-'));
  const releases = [];
  const log = { queries: [], reports: [], events: [], downloads: [] };

  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://localhost:${port}`);
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const json = (status, value) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };

      if (url.pathname === '/v0.1/public/codepush/update_check') {
        const query = Object.fromEntries(url.searchParams);
        log.queries.push(query);
        const latest = releases.at(-1);
        if (!latest || latest.packageHash === query.package_hash) {
          return json(200, { update_info: { is_available: false } });
        }
        const diff = latest.diffs[query.package_hash];
        return json(200, {
          update_info: {
            is_available: true,
            is_mandatory: latest.mandatory,
            label: latest.label,
            description: `release ${latest.label}`,
            package_hash: latest.packageHash,
            package_size: statSync(diff ?? latest.zip).size,
            target_binary_range: query.app_version,
            download_url: `http://localhost:${port}/download/${latest.label}${diff ? '-diff' : ''}.zip`,
          },
        });
      }
      if (url.pathname.startsWith('/v0.1/public/codepush/report_status/')) {
        log.reports.push({ kind: url.pathname.split('/').at(-1), ...body });
        return json(200, {});
      }
      if (url.pathname.startsWith('/download/')) {
        const name = url.pathname.slice('/download/'.length).replace(/\.zip$/, '');
        const release = releases.find((each) => name === each.label || name === `${each.label}-diff`);
        const path = name.endsWith('-diff') ? Object.values(release.diffs)[0] : release?.zip;
        if (!path) {
          response.writeHead(404).end();
          return;
        }
        log.downloads.push(name);
        response.writeHead(200, { 'Content-Type': 'application/zip' });
        response.end(readFileSync(path));
        return;
      }
      if (url.pathname === '/__event') {
        log.events.push(body);
        return json(200, {});
      }
      response.writeHead(404).end();
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () =>
      resolve({
        log,
        /** Publishes the web build in `webDir` as `label`; `diffFrom` names a release to offer a diff against. */
        release({ label, webDir, mandatory = false, diffFrom }) {
          const releaseRoot = join(work, label, 'www');
          mkdirSync(dirname(releaseRoot), { recursive: true });
          cpSync(webDir, releaseRoot, { recursive: true });
          const zip = join(work, `${label}.zip`);
          zipRelease(releaseRoot, zip);
          const entry = { label, mandatory, packageHash: referencePackageHash(releaseRoot), zip, diffs: {} };
          if (diffFrom) {
            const from = releases.find((each) => each.label === diffFrom);
            const fromRoot = join(work, diffFrom, 'www');
            const rel = (file, root) => relative(root, file);
            const oldFiles = new Map(files(fromRoot).map((file) => [rel(file, fromRoot), readFileSync(file)]));
            const changed = files(releaseRoot).filter((file) => {
              const before = oldFiles.get(rel(file, releaseRoot));
              return !before || !before.equals(readFileSync(file));
            });
            const deleted = [...oldFiles.keys()].filter(
              (path) => !files(releaseRoot).some((f) => rel(f, releaseRoot) === path),
            );
            const diffZip = join(work, `${label}-diff.zip`);
            zipRelease(releaseRoot, diffZip, changed);
            const manifest = join(dirname(releaseRoot), 'hotcodepush.json');
            writeFileSync(manifest, JSON.stringify({ deletedFiles: deleted.map((path) => `www/${path}`) }));
            execFileSync('zip', ['-q', '-X', diffZip, 'hotcodepush.json'], { cwd: dirname(releaseRoot) });
            rmSync(manifest);
            entry.diffs[from.packageHash] = diffZip;
            entry.diffSummary = { changed: changed.map((file) => rel(file, releaseRoot)), deleted };
          }
          releases.push(entry);
          return entry;
        },
        close() {
          server.close();
          rmSync(work, { recursive: true, force: true });
        },
      }),
    );
  });
}
