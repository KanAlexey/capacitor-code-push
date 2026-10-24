import type { HttpRequester, HttpResponse } from './acquisition-client';

/** The slice of `CapacitorHttp` the requester uses, so a test can hand in its own. */
export interface CapacitorHttpLike {
  request(options: {
    method: string;
    url: string;
    headers: Record<string, string>;
    data?: unknown;
    responseType: 'text';
  }): Promise<{ status: number; data: unknown }>;
}

/**
 * Sends the protocol's requests through `CapacitorHttp.request`, which runs natively and so needs no CORS from the
 * server. Calling it directly works whether or not the app lets CapacitorHttp patch `fetch`.
 */
export function capacitorHttpRequester(http: CapacitorHttpLike, headers: Record<string, string>): HttpRequester {
  return {
    async request(method, url, body): Promise<HttpResponse> {
      const response = await http.request({
        method,
        url,
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        data: body,
        responseType: 'text',
      });
      // A JSON answer can come back already parsed, whatever responseType asked for.
      const text =
        typeof response.data === 'string'
          ? response.data
          : response.data === undefined || response.data === null
            ? ''
            : JSON.stringify(response.data);
      return { status: response.status, body: text };
    },
  };
}
