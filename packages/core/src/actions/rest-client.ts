export interface RestResponse {
  status: number;
  body: unknown;
}

/**
 * The only way core reaches Discord (PLAN.md I2) — plain HTTP to the proxy,
 * never a REST client of its own.
 */
export interface RestRequestOptions {
  method: string;
  path: string;
  body?: unknown;
  /** Forwarded verbatim — carries X-Audit-Log-Reason for moderation actions. */
  headers?: Record<string, string>;
}

export interface RestProxyClient {
  request(options: RestRequestOptions): Promise<RestResponse>;
}

export class HttpRestProxyClient implements RestProxyClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    const response = await fetch(`${this.#baseUrl}/api${options.path}`, {
      method: options.method,
      headers: { 'content-type': 'application/json', ...options.headers },
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
