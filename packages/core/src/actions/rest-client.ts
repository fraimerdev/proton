export interface RestResponse {
  status: number;
  body: unknown;
}

export interface RestFile {
  name: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface RestRequestOptions {
  method: string;
  path: string;
  body?: unknown;

  headers?: Record<string, string>;

  files?: RestFile[];

  timeoutMs?: number;
}

export interface RestProxyClient {
  request(options: RestRequestOptions): Promise<RestResponse>;
}

export class RestTimeoutError extends Error {
  readonly method: string;
  readonly path: string;
  readonly timeoutMs: number;

  constructor(method: string, path: string, timeoutMs: number) {
    super(
      `The rest-proxy did not answer ${method} ${path} within ${timeoutMs} ms. ` +
        'Discord may still have applied the request.',
    );
    this.name = 'RestTimeoutError';
    this.method = method;
    this.path = path;
    this.timeoutMs = timeoutMs;
  }
}

export class HttpRestProxyClient implements RestProxyClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    const multipart = options.files && options.files.length > 0;
    const controller = options.timeoutMs === undefined ? undefined : new AbortController();
    const signal = controller?.signal;
    // Not AbortSignal.timeout: its unref'd timer never fires when nothing else holds the loop open.
    const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;

    try {
      const response = await fetch(`${this.#baseUrl}/api${options.path}`, {
        method: options.method,

        // No content-type on multipart: `fetch` must set it so the boundary matches its own body.
        headers: multipart
          ? { ...options.headers }
          : { 'content-type': 'application/json', ...options.headers },
        ...bodyFor(options, multipart === true),
        ...(signal ? { signal } : {}),
      });

      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }

      return { status: response.status, body };
    } catch (error) {
      if (signal?.aborted && options.timeoutMs !== undefined) {
        throw new RestTimeoutError(options.method, options.path, options.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function bodyFor(options: RestRequestOptions, multipart: boolean): { body?: string | FormData } {
  if (!multipart) {
    return options.body !== undefined ? { body: JSON.stringify(options.body) } : {};
  }

  const form = new FormData();
  if (options.body !== undefined) form.append('payload_json', JSON.stringify(options.body));

  for (const file of options.files ?? []) {
    const bytes = new Uint8Array(file.data);
    form.append(file.name, new Blob([bytes], { type: file.contentType }), file.filename);
  }

  return { body: form };
}
