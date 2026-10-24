#!/usr/bin/env bash
# XCTest of the plugin's core on the macOS host (swift test), and its coverage as a llvm-cov summary in coverage/ios.json.
# The core is Foundation, CryptoKit and ZIPFoundation, the same APIs on macOS as on iOS, so it needs no simulator: the iOS
# glue is built for a device by `npm run verify:ios` and runs on a simulator in the end-to-end tests. `npm run test:ios`
# runs these same tests on a simulator. Run from test/ios (`npm run test:ios:coverage`).
set -euo pipefail
scratch=.build/host
swift test --scratch-path "$scratch" --enable-code-coverage
bin=$(swift build --scratch-path "$scratch" --show-bin-path)
mkdir -p ../../coverage
# only the plugin's sources: not the tests, not ZIPFoundation
xcrun llvm-cov export -summary-only -instr-profile="$bin/codecov/default.profdata" \
  "$bin/CodePushCoreTestsPackageTests.xctest/Contents/MacOS/CodePushCoreTestsPackageTests" \
  -ignore-filename-regex='(Tests|\.build|node_modules|SourcePackages|checkouts)' > ../../coverage/ios.json
