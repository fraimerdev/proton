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
    const multipart = options.files && options.files.length > 0;

    const response = await fetch(`${this.#baseUrl}/api${options.path}`, {
      method: options.method,

      // No content-type on multipart: `fetch` must set it so the boundary matches its own body.
      headers: multipart
        ? { ...options.headers }
        : { 'content-type': 'application/json', ...options.headers },
      ...bodyFor(options, multipart === true),
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
