/**
 * The package hash exactly as @revopush/code-push-cli 0.0.11 computes it (script/hash-utils.ts:
 * generatePackageHashFromDirectory, PackageManifest.computePackageHash, PackageManifest.isIgnored), written again
 * here so that the native hashers can be checked against the server's algorithm rather than against each other.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

function isIgnored(relativeFilePath: string): boolean {
  return (
    relativeFilePath.startsWith('__MACOSX/') ||
    relativeFilePath === '.DS_Store' ||
    relativeFilePath.endsWith('/.DS_Store')
  );
}

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** Hash of `releaseRoot`, with paths relative to its parent, as `release <path to releaseRoot>` uploads it. */
export function referencePackageHash(releaseRoot: string): string {
  const basePath = dirname(releaseRoot);
  const entries: string[] = [];
  for (const file of listFiles(releaseRoot)) {
    const relativePath = relative(basePath, file).replace(/\\/g, '/');
    if (!isIgnored(relativePath)) {
      entries.push(`${relativePath}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`);
    }
  }
  entries.sort();
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
