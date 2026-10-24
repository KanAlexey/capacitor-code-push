import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { capacitorHttpRequester } from '../../src/capacitor-http-requester';
import type { CapacitorHttpLike } from '../../src/capacitor-http-requester';
import { PLUGIN_VERSION } from '../../src/version';

function fakeHttp(data: unknown, status = 200) {
  const request = vi.fn<CapacitorHttpLike['request']>(async () => ({ status, data }));
  return { http: { request } satisfies CapacitorHttpLike, request };
}

describe('capacitorHttpRequester', () => {
  it('sends a GET with the base headers and no body', async () => {
    const { http, request } = fakeHttp('{"a":1}');

    const response = await capacitorHttpRequester(http, { 'X-One': '1' }).request('GET', 'https://x.test/q');

    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://x.test/q',
      headers: { 'X-One': '1' },
      data: undefined,
      responseType: 'text',
    });
    expect(response).toEqual({ status: 200, body: '{"a":1}' });
  });

  it('sends a POST body as JSON', async () => {
    const { http, request } = fakeHttp('');

    await capacitorHttpRequester(http, { 'X-One': '1' }).request('POST', 'https://x.test/r', { label: 'v1' });

    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      headers: { 'X-One': '1', 'Content-Type': 'application/json' },
      data: { label: 'v1' },
    });
  });

  it('turns an answer the native side already parsed back into text', async () => {
    const parsed = await capacitorHttpRequester(fakeHttp({ update_info: {} }).http, {}).request('GET', 'u');
    const empty = await capacitorHttpRequester(fakeHttp(null, 204).http, {}).request('GET', 'u');

    expect(parsed).toEqual({ status: 200, body: '{"update_info":{}}' });
    expect(empty).toEqual({ status: 204, body: '' });
  });

  it('passes a non-200 status through rather than throwing', async () => {
    expect(await capacitorHttpRequester(fakeHttp('gone', 410).http, {}).request('GET', 'u')).toEqual({
      status: 410,
      body: 'gone',
    });
  });
});

describe('PLUGIN_VERSION', () => {
  it("is package.json's version", () => {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string };

    expect(PLUGIN_VERSION).toBe(packageJson.version);
  });
});
