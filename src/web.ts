import { WebPlugin } from '@capacitor/core';

import type { CodePushPlugin } from './definitions';

export class CodePushWeb extends WebPlugin implements CodePushPlugin {
  async echo(options: { value: string }): Promise<{ value: string }> {
    console.log('ECHO', options);
    return options;
  }
}
