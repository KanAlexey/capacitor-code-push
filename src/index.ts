import { CapacitorHttp, registerPlugin } from '@capacitor/core';

import { capacitorHttpRequester } from './capacitor-http-requester';
import { CodePushClient } from './code-push';
import type { CodePushNativePlugin, CodePushPlugin } from './definitions';
import { PLUGIN_NAME_HEADER, PLUGIN_VERSION, PROTOCOL_SDK_VERSION } from './version';

const native = registerPlugin<CodePushNativePlugin>('CodePush', {
  web: () => import('./web').then((m) => new m.CodePushWeb()),
});

const http = capacitorHttpRequester(CapacitorHttp, {
  'X-CodePush-Plugin-Name': PLUGIN_NAME_HEADER,
  'X-CodePush-Plugin-Version': PLUGIN_VERSION,
  'X-CodePush-SDK-Version': PROTOCOL_SDK_VERSION,
});

/** The plugin. A plain object, not the Capacitor Proxy, so it answers only the properties it has. */
const CodePush: CodePushPlugin = new CodePushClient(native, http);

export * from './definitions';
export { CodePushError } from './code-push';
export { CodePushHttpError } from './acquisition-client';
export { CodePush };
