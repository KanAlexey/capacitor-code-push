#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * The line coverage of one layer of the tests, read from what its tool wrote, printed (and added to a CI job's summary), and
 * compared with its floor in floors.json:
 *
 *   node test/coverage/summarize.mjs js | android | ios
 *
 * A floor is not a target: it holds what is measured, so coverage cannot fall without somebody choosing to lower it here.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const layers = {
  // Vitest's lcov reporter: LF lines found, LH lines hit
  js: {
    title: 'Vitest, src/',
    lines() {
      const lcov = read('coverage/lcov.info');
      const sum = (key) => [...lcov.matchAll(new RegExp(`^${key}:(\\d+)`, 'gm'))].reduce((total, match) => total + Number(match[1]), 0);
      return { found: sum('LF'), hit: sum('LH') };
    },
  },
  // JaCoCo's XML: the counters after the last package belong to the whole report
  android: {
    title: 'Android JVM tests, android/src/main',
    lines() {
      const xml = read('android/build/reports/coverage/test/debug/report.xml');
      const whole = xml.slice(xml.lastIndexOf('</package>'));
      const [, missed, covered] = /<counter type="LINE" missed="(\d+)" covered="(\d+)"\/>/.exec(whole);
      return { found: Number(missed) + Number(covered), hit: Number(covered) };
    },
  },
  // llvm-cov export, for ios/Sources/CodePushCore only (test/ios/coverage.sh)
  ios: {
    title: 'XCTest on a simulator, ios/Sources/CodePushCore',
    lines() {
      const { count, covered } = JSON.parse(read('coverage/ios.json')).data[0].totals.lines;
      return { found: count, hit: covered };
    },
  },
};

const name = process.argv[2];
const layer = layers[name];
if (!layer) {
  console.error(`usage: summarize.mjs ${Object.keys(layers).join(' | ')}`);
  process.exit(2);
}

const floor = JSON.parse(read('test/coverage/floors.json'))[name].lines;
const { found, hit } = layer.lines();
const percent = found === 0 ? 0 : (100 * hit) / found;
const ok = percent >= floor;

const line = `${layer.title}: ${percent.toFixed(1)}% of lines (${hit} of ${found}), floor ${floor}% ${ok ? 'held' : 'NOT HELD'}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Coverage: ${layer.title}\n\n| lines | covered | floor | |\n| --- | --- | --- | --- |\n| ${found} | ${hit} (${percent.toFixed(1)}%) | ${floor}% | ${ok ? 'held' : '**below the floor**'} |\n\n`,
  );
}
process.exit(ok ? 0 : 1);
