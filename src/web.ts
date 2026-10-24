import { WebPlugin } from '@capacitor/core';

import type { CodePushNativePlugin, LocalPackage, NativeConfiguration, StatusReport } from './definitions';

/**
 * There is nothing to update in a browser: the web build is served as it is. Reads answer "store bundle, nothing
 * pending" so an app's start-up runs unchanged; anything that would fetch or install refuses.
 */
export class CodePushWeb extends WebPlugin implements Omit<CodePushNativePlugin, 'addListener'> {
  async getConfiguration(): Promise<NativeConfiguration> {
    throw this.unavailable('CodePush is not available on the web.');
  }

  async getBinaryHash(): Promise<{ hash: string }> {
    throw this.unavailable('CodePush is not available on the web.');
  }

  async getCurrentPackage(): Promise<{ package: LocalPackage | null }> {
    return { package: null };
  }

  async getPendingPackage(): Promise<{ package: LocalPackage | null }> {
    return { package: null };
  }

  async isFailedUpdate(): Promise<{ failed: boolean }> {
    return { failed: false };
  }

  async downloadPackage(): Promise<{ package: LocalPackage }> {
    throw this.unavailable('CodePush is not available on the web.');
  }

  async installPackage(): Promise<void> {
    throw this.unavailable('CodePush is not available on the web.');
  }

  async notifyApplicationReady(): Promise<{ statusReport: StatusReport | null }> {
    return { statusReport: null };
  }

  async recordStatusReported(): Promise<void> {
    return;
  }

  async saveStatusReportForRetry(): Promise<void> {
    return;
  }

  async restartApplication(): Promise<{ restarted: boolean }> {
    return { restarted: false };
  }
}
