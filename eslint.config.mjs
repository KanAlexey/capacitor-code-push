// ESLint 10 reads only this flat config. The Ionic rule sets apply to TypeScript files alone.
import ionic from '@ionic/eslint-config/recommended.js';

export default [
  {
    // Build output, the demo (a project of its own) and the hash fixture, which a fix would change and so break its hash.
    ignores: ['dist/**', 'build/**', 'coverage/**', 'android/**', 'ios/**', 'demo/**', 'test/fixtures/**'],
  },
  ...ionic,
];
