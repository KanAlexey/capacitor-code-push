import { describe, expect, it } from 'vitest';

import { AcquisitionClient, CodePushHttpError } from '../../src/acquisition-client';
import type { HttpRequester, HttpResponse } from '../../src/acquisition-client';

interface Sent {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

function requester(answer: HttpResponse | Error = { status: 200, body: '{}' }) {
  const sent: Sent[] = [];
  const http: HttpRequester = {
    async request(method, url, body) {
      sent.push({ method, url, body });
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
  return { http, sent };
}

const config = {
  serverUrl: 'https://updates.example.com',
  deploymentKey: 'key-1',
  appVersion: '2.3.4',
  clientUniqueId: 'client-9',
};

describe('AcquisitionClient.queryUpdate', () => {
  it('asks update_check with the fields in the original order, adding the missing slash', async () => {
    const { http, sent } = requester({ status: 200, body: '{"update_info":{"is_available":false}}' });

    await new AcquisitionClient(http, config).queryUpdate({ appVersion: '2.3.4', packageHash: 'abc', label: 'v7' });

    expect(sent).toEqual([
      {
        method: 'GET',
        url:
          'https://updates.example.com/v0.1/public/codepush/update_check?deployment_key=key-1&app_version=2.3.4' +
          '&package_hash=abc&is_companion=false&label=v7&client_unique_id=client-9',
        body: undefined,
      },
    ]);
  });

  it('leaves out a field that is absent and encodes the values', async () => {
    const { http, sent } = requester({ status: 200, body: '{}' });

    await new AcquisitionClient(http, { ...config, serverUrl: 'https://x.test/', deploymentKey: 'a b&c' }).queryUpdate({
      appVersion: '1.0 beta',
    });

    expect(sent[0].url).toBe(
      'https://x.test/v0.1/public/codepush/update_check?deployment_key=a%20b%26c&app_version=1.0%20beta' +
        '&is_companion=false&client_unique_id=client-9',
    );
  });

  it('answers up to date without update_info and when nothing is available', async () => {
    for (const body of ['{}', '{"update_info":{"is_available":false}}']) {
      const { http } = requester({ status: 200, body });
      expect(await new AcquisitionClient(http, config).queryUpdate({ appVersion: '2.3.4' })).toEqual({
        kind: 'upToDate',
      });
    }
  });

  it('answers that a newer binary is needed', async () => {
    const { http } = requester({
      status: 200,
      body: '{"update_info":{"update_app_version":true,"target_binary_range":"3.0.0"}}',
    });

    expect(await new AcquisitionClient(http, config).queryUpdate({ appVersion: '2.3.4' })).toEqual({
      kind: 'binaryUpdateRequired',
      appVersion: '3.0.0',
    });
  });

  it('maps an available update onto a package carrying the deployment key it was asked with', async () => {
    const { http } = requester({
      status: 200,
      body: JSON.stringify({
        update_info: {
          is_available: true,
          target_binary_range: '2.3.4',
          description: 'fixes',
          label: 'v8',
          is_mandatory: true,
          package_hash: 'h8',
          package_size: 1234,
          download_url: 'https://cdn.example.com/v8.zip',
        },
      }),
    });

    expect(await new AcquisitionClient(http, config).queryUpdate({ appVersion: '2.3.4' })).toEqual({
      kind: 'update',
      package: {
        deploymentKey: 'key-1',
        description: 'fixes',
        label: 'v8',
        appVersion: '2.3.4',
        isMandatory: true,
        packageHash: 'h8',
        packageSize: 1234,
        downloadUrl: 'https://cdn.example.com/v8.zip',
      },
    });
  });

  it('turns a non-200 answer into an error carrying the status and body', async () => {
    const { http } = requester({ status: 404, body: 'no such deployment' });

    const error = await new AcquisitionClient(http, config).queryUpdate({ appVersion: '2.3.4' }).catch((e) => e);

    expect(error).toBeInstanceOf(CodePushHttpError);
    expect(error).toMatchObject({ status: 404, message: '404: no such deployment' });
  });

  it('names the URL when no answer arrived at all', async () => {
    const { http } = requester(new Error('offline'));

    await expect(new AcquisitionClient(http, config).queryUpdate({ appVersion: '2.3.4' })).rejects.toThrow(
      /^Couldn't send request to https:\/\/updates\.example\.com\/v0\.1\/public\/codepush\/update_check\?.*: offline$/,
    );
  });

  it('refuses to ask without an app version', async () => {
    const { http, sent } = requester();

    await expect(new AcquisitionClient(http, config).queryUpdate({ appVersion: '' })).rejects.toThrow(/app version/);
    expect(sent).toEqual([]);
  });
});

describe('AcquisitionClient.reportDeploy', () => {
  const deployUrl = 'https://updates.example.com/v0.1/public/codepush/report_status/deploy';

  it('reports the binary version without a package', async () => {
    const { http, sent } = requester();

    await new AcquisitionClient(http, config).reportDeploy(undefined, undefined, 'v3', 'old-key');

    expect(sent).toEqual([
      {
        method: 'POST',
        url: deployUrl,
        body: {
          app_version: '2.3.4',
          deployment_key: 'key-1',
          client_unique_id: 'client-9',
          previous_label_or_app_version: 'v3',
          previous_deployment_key: 'old-key',
        },
      },
    ]);
  });

  it("reports a package's outcome with its label and app version", async () => {
    const { http, sent } = requester();

    await new AcquisitionClient(http, config).reportDeploy({ label: 'v8', appVersion: '2.3.0' }, 'DeploymentFailed');

    expect(sent[0].body).toEqual({
      app_version: '2.3.0',
      deployment_key: 'key-1',
      client_unique_id: 'client-9',
      label: 'v8',
      status: 'DeploymentFailed',
    });
  });

  it('refuses a package report without a known status and sends nothing', async () => {
    const { http, sent } = requester();
    const client = new AcquisitionClient(http, config);

    await expect(client.reportDeploy({ label: 'v8', appVersion: '2.3.0' })).rejects.toThrow('Missing status argument.');
    await expect(
      client.reportDeploy({ label: 'v8', appVersion: '2.3.0' }, 'Nope' as 'DeploymentFailed'),
    ).rejects.toThrow('Unrecognized status "Nope".');
    expect(sent).toEqual([]);
  });

  it('fails on a non-200 answer so the caller can keep the report for a retry', async () => {
    const { http } = requester({ status: 500, body: 'later' });

    await expect(new AcquisitionClient(http, config).reportDeploy()).rejects.toBeInstanceOf(CodePushHttpError);
  });
});

describe('AcquisitionClient.reportDownload', () => {
  it('reports the label with the client and the key', async () => {
    const { http, sent } = requester();

    await new AcquisitionClient(http, config).reportDownload({ label: 'v8' });

    expect(sent).toEqual([
      {
        method: 'POST',
        url: 'https://updates.example.com/v0.1/public/codepush/report_status/download',
        body: { client_unique_id: 'client-9', deployment_key: 'key-1', label: 'v8' },
      },
    ]);
  });
});
