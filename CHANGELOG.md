# Changelog

## Unreleased

## v0.1.0

- First version: `sync`, `checkForUpdate`, `download`, `install`, `getCurrentPackage`, `getPendingPackage`,
  `notifyApplicationReady` and `restartApplication` for Capacitor 8 on Android and iOS, speaking the CodePush protocol
  to a CodePush-compatible server such as Revopush
- Install modes `IMMEDIATE`, `ON_NEXT_RESTART` and `ON_NEXT_RESUME`; mandatory updates; rollback at the next cold start
  of a package that never called `notifyApplicationReady`, reported to the server
- Diff updates, checked against the package hash the Revopush CLI computes; full updates installed as delivered
- `onUpdateAvailable` is a required `sync` option: the plugin shows no dialog of its own
- Moving from cordova-plugin-code-push: the same client id and the last reported version carried over
- Tests: TypeScript (Vitest), Kotlin on the JVM, XCTest on an iOS simulator, and an end-to-end run of the demo app on
  an iOS simulator and an Android emulator against a local CodePush server
