/*
 * The CodePush acquisition protocol: the update check and the two status reports.
 *
 * Adapted from microsoft/code-push, script/acquisition-sdk.ts, which carries this notice:
 *
 *   Copyright (c) Microsoft Corporation. All rights reserved.
 *
 *   MIT License
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 *   documentation files (the "Software"), to deal in the Software without restriction, including without
 *   limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
 *   Software, and to permit persons to whom the Software is furnished to do so, subject to the following
 *   conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or substantial portions
 *   of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 *   TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 *   THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 *   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 *
 * Differences from the original: promises instead of callbacks, an injected HTTP requester, and the configuration
 * taken only from the constructor (no `window` globals).
 */

import type { DeploymentStatus, Package } from './definitions';

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpRequester {
  /** Resolves with any HTTP status; rejects only when no answer arrived at all. */
  request(method: 'GET' | 'POST', url: string, body?: Record<string, unknown>): Promise<HttpResponse>;
}

export interface AcquisitionConfig {
  serverUrl: string;
  deploymentKey: string;
  /** The binary's version. */
  appVersion: string;
  clientUniqueId: string;
  ignoreAppVersion?: boolean;
}

/** What the update check is asked about: the latest installed package, or the store bundle. */
export interface QueryPackage {
  appVersion: string;
  packageHash?: string;
  label?: string;
}

export type UpdateCheckResult =
  | { kind: 'upToDate' }
  | { kind: 'binaryUpdateRequired'; appVersion: string }
  | { kind: 'update'; package: Omit<Package, 'failedInstall'> & { downloadUrl: string } };

export class CodePushHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CodePushHttpError';
  }
}

const PUBLIC_PREFIX = 'v0.1/public/codepush/';

interface UpdateInfo {
  update_app_version?: boolean;
  is_available?: boolean;
  target_binary_range?: string;
  description?: string;
  label?: string;
  is_mandatory?: boolean;
  package_hash?: string;
  package_size?: number;
  download_url?: string;
}

export class AcquisitionClient {
  private readonly serverUrl: string;

  constructor(
    private readonly http: HttpRequester,
    private readonly config: AcquisitionConfig,
  ) {
    this.serverUrl = config.serverUrl.endsWith('/') ? config.serverUrl : `${config.serverUrl}/`;
  }

  async queryUpdate(current: QueryPackage): Promise<UpdateCheckResult> {
    if (!current.appVersion) {
      throw new Error('An update check needs the app version.');
    }
    const query = queryString([
      ['deployment_key', this.config.deploymentKey],
      ['app_version', current.appVersion],
      ['package_hash', current.packageHash],
      ['is_companion', this.config.ignoreAppVersion ?? false],
      ['label', current.label],
      ['client_unique_id', this.config.clientUniqueId],
    ]);
    const url = `${this.serverUrl}${PUBLIC_PREFIX}update_check?${query}`;
    const response = await this.send('GET', url);

    const updateInfo = (JSON.parse(response.body) as { update_info?: UpdateInfo }).update_info;
    if (!updateInfo) {
      return { kind: 'upToDate' };
    }
    if (updateInfo.update_app_version) {
      return { kind: 'binaryUpdateRequired', appVersion: updateInfo.target_binary_range ?? '' };
    }
    if (!updateInfo.is_available) {
      return { kind: 'upToDate' };
    }
    return {
      kind: 'update',
      package: {
        deploymentKey: this.config.deploymentKey,
        description: updateInfo.description ?? '',
        label: updateInfo.label ?? '',
        appVersion: updateInfo.target_binary_range ?? '',
        isMandatory: Boolean(updateInfo.is_mandatory),
        packageHash: updateInfo.package_hash ?? '',
        packageSize: updateInfo.package_size ?? 0,
        downloadUrl: updateInfo.download_url ?? '',
      },
    };
  }

  /** Without a package this reports the binary version; with one, the outcome of deploying it. */
  async reportDeploy(
    deployedPackage?: Pick<Package, 'label' | 'appVersion'>,
    status?: DeploymentStatus,
    previousLabelOrAppVersion?: string,
    previousDeploymentKey?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      app_version: this.config.appVersion,
      deployment_key: this.config.deploymentKey,
    };
    if (this.config.clientUniqueId) {
      body.client_unique_id = this.config.clientUniqueId;
    }
    if (deployedPackage) {
      if (status !== 'DeploymentSucceeded' && status !== 'DeploymentFailed') {
        throw new Error(status ? `Unrecognized status "${status}".` : 'Missing status argument.');
      }
      body.label = deployedPackage.label;
      body.app_version = deployedPackage.appVersion;
      body.status = status;
    }
    if (previousLabelOrAppVersion) {
      body.previous_label_or_app_version = previousLabelOrAppVersion;
    }
    if (previousDeploymentKey) {
      body.previous_deployment_key = previousDeploymentKey;
    }
    await this.send('POST', `${this.serverUrl}${PUBLIC_PREFIX}report_status/deploy`, body);
  }

  async reportDownload(downloadedPackage: Pick<Package, 'label'>): Promise<void> {
    await this.send('POST', `${this.serverUrl}${PUBLIC_PREFIX}report_status/download`, {
      client_unique_id: this.config.clientUniqueId,
      deployment_key: this.config.deploymentKey,
      label: downloadedPackage.label,
    });
  }

  private async send(method: 'GET' | 'POST', url: string, body?: Record<string, unknown>): Promise<HttpResponse> {
    let response: HttpResponse;
    try {
      response = await this.http.request(method, url, body);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Couldn't send request to ${url}: ${reason}`, { cause: error });
    }
    if (response.status !== 200) {
      throw new CodePushHttpError(`${response.status}: ${response.body}`, response.status);
    }
    return response;
  }
}

function queryString(fields: [string, string | boolean | undefined | null][]): string {
  return fields
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join('&');
}
