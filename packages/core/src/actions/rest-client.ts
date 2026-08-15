export interface RestResponse {
  status: number;
  body: unknown;
}

/**
 * The only way core reaches Discord (PLAN.md I2) — plain HTTP to the proxy,
 * never a REST client of its own.
 */
/** One uploaded file, as the proxy's multipart handler expects it. */
export interface RestFile {
  /** Form field name — `files[0]`, `files[1]`, … */
  name: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface RestRequestOptions {
  method: string;
  path: string;
  body?: unknown;
  /** Forwarded verbatim — carries X-Audit-Log-Reason for moderation actions. */
  headers?: Record<string, string>;
  /**
   * Files to upload. When present the request is sent as `multipart/form-data`
   * with `body` serialised into the `payload_json` field, per Discord's upload
   * reference — never as JSON with the bytes inlined, which is not a thing the
   * API accepts.
   */
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
      // No explicit content-type for multipart: `fetch` has to set it itself so
      // the boundary parameter matches the body it generated. Supplying one by
      // hand produces a body the far side cannot parse.
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

/**
 * The request body, in whichever encoding this call needs.
 *
 * Split out because the multipart shape is fiddly enough to be worth naming: the
 * JSON goes in a `payload_json` field rather than being the body, and each file
 * is its own part whose field name (`files[n]`) is what the `attachments[]`
 * descriptors in that JSON refer to by index. Getting the two out of step
 * uploads the bytes and then renders an embed pointing at nothing.
 */
function bodyFor(options: RestRequestOptions, multipart: boolean): { body?: string | FormData } {
  if (!multipart) {
    return options.body !== undefined ? { body: JSON.stringify(options.body) } : {};
  }

  const form = new FormData();
  if (options.body !== undefined) form.append('payload_json', JSON.stringify(options.body));

  for (const file of options.files ?? []) {
    // Copied into a fresh ArrayBuffer: a Uint8Array may be a view onto a larger
    // pooled buffer, and Blob would otherwise capture the whole of it.
    const bytes = new Uint8Array(file.data);
    form.append(file.name, new Blob([bytes], { type: file.contentType }), file.filename);
  }

  return { body: form };
}
