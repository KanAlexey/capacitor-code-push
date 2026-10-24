# capacitor-code-push demo

A Capacitor app with one button per call of the plugin, and the answer of each shown on screen.

```bash
npm install
npm run ios:sync       # or android:sync: pack the plugin, install that copy, build the web app, sync the project
npx cap open ios       # or android
```

`npm run plugin:pack` puts the plugin this checkout holds into `.plugin/` the way npm would ship it (built, packed,
unpacked), and the demo depends on that folder, so it runs exactly the files `package.json` publishes.

Set `plugins.CodePush` in `capacitor.config.json` to your server and keys first. As committed it points at
`http://localhost:3999/`, the CodePush server the end-to-end tests start (`test/e2e/fake-server.mjs`).

## The autopilot

`src/js/example.js` also carries the autopilot `test/e2e` drives. It is off unless the page has an `e2e-server` meta
tag, which the tests add to the builds they release: on every page load it reports what is served, confirms the
package when `e2e-confirm` says so and syncs when `e2e-sync` says so, posting each step to the test server.
