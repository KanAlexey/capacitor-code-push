# Contributing

This guide provides instructions for contributing to this Capacitor plugin.

## Developing

### Local Setup

1. Fork and clone the repo.
1. Install the dependencies.

    ```shell
    npm install
    ```

1. Install SwiftLint if you're on macOS.

    ```shell
    brew install swiftlint
    ```

### Scripts

#### `npm run build`

Build the plugin web assets and generate plugin API documentation using [`@capacitor/docgen`](https://github.com/ionic-team/capacitor-docgen).

It will compile the TypeScript code from `src/` into ESM JavaScript in `dist/esm/`. These files are used in apps with bundlers when your plugin is imported.

Then, Rollup will bundle the code into a single file at `dist/plugin.js`. This file is used in apps without bundlers by including it as a script in `index.html`.

#### Tests

Every layer and its command is in the README's [Tests](README.md#tests) section. A change to the install or rollback
rules needs its case in the state machine tests of both platforms (`android/src/test`, `test/ios/Tests`), and a change
a user would notice goes into `CHANGELOG.md` under `Unreleased`.

#### `npm run verify`

Build and validate the web and native projects.

This is useful to run in CI to verify that the plugin builds for all platforms.

#### `npm run lint` / `npm run fmt`

Check formatting and code quality, autoformat/autofix if possible.

This template is integrated with ESLint, Prettier, and SwiftLint. Using these tools is completely optional, but the [Capacitor Community](https://github.com/capacitor-community/) strives to have consistent code style and structure for easier cooperation.

## Publishing

Nothing is published by hand. A push to `master` runs `.github/workflows/test.yml`, and when every job passes and the
version in `package.json` is not on npm yet, its `publish` job publishes it through npm's trusted publishing, tags
the commit that first carried the version, and makes a GitHub release from that version's block of `CHANGELOG.md`.
So a release is: move the `Unreleased` notes under a new `## v<version>` heading, bump `version` in `package.json`
and `src/version.ts` (a test keeps them equal), and merge.

> **Note**: The [`files`](https://docs.npmjs.com/cli/v7/configuring-npm/package-json#files) array in `package.json`
> specifies which files get published. The demo installs the plugin from a packed copy, so a file missing there breaks
> the demo and the end-to-end tests first.
