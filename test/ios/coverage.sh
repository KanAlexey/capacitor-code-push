#!/usr/bin/env bash
# XCTest with code coverage, and the coverage of the plugin's core (ios/Sources/CodePushCore) as a llvm-cov summary in
# coverage/ios.json. Run from test/ios (`npm run test:ios:coverage`).
set -euo pipefail
derived=.build/derived-data
# Only the last run's coverage goes: the rest of the derived data is what CI caches for an incremental build.
rm -rf "$derived"/Build/ProfileData "$derived"/Logs/Test
xcodebuild test -scheme CodePushCoreTests-Package -destination "platform=iOS Simulator,id=$(node simulator.mjs --udid)" \
  -skipPackagePluginValidation -enableCodeCoverage YES -derivedDataPath "$derived"
profile=$(ls -t "$derived"/Build/ProfileData/*/Coverage.profdata | head -1)
binary="$derived/Build/Products/Debug-iphonesimulator/CodePushCoreTests.xctest/CodePushCoreTests"
mkdir -p ../../coverage
# only the plugin's sources: not the tests, not ZIPFoundation
xcrun llvm-cov export -summary-only -instr-profile="$profile" "$binary" \
  -ignore-filename-regex='(Tests|\.build|node_modules|SourcePackages|checkouts)' > ../../coverage/ios.json
