export interface RestResponse {
  status: number;
  body: unknown;
}

/**
 * The only way core reaches Discord (PLAN.md I2) — plain HTTP to the proxy,
 * never a REST client of its own.
 */
export interface RestProxyClient {
  request(options: { method: string; path: string; body?: unknown }): Promise<RestResponse>;
}

export class HttpRestProxyClient implements RestProxyClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request(options: { method: string; path: string; body?: unknown }): Promise<RestResponse> {
    const response = await fetch(`${this.#baseUrl}/api${options.path}`, {
      method: options.method,
      headers: { 'content-type': 'application/json' },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }

    return { status: response.status, body };
  }
}
