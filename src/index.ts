import { registerPlugin } from '@capacitor/core';

import type { CodePushPlugin } from './definitions';

const CodePush = registerPlugin<CodePushPlugin>('CodePush', {
  web: () => import('./web').then((m) => new m.CodePushWeb()),
});

export * from './definitions';
export { CodePush };
