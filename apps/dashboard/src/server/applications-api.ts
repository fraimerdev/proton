import { z } from 'zod';
import { loadEnv } from '../lib/env.ts';

const env = loadEnv();

const apiMessageSchema = z.object({ message: z.string() });

export interface ApiInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

function url(path: string): string {
  return `${env.API_URL.replace(/\/$/, '')}${path}`;
}

export function apiQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }

  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export async function rawApplicationsApi(path: string, init: ApiInit = {}): Promise<Response> {
  return fetch(url(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-proton-secret': env.API_SHARED_SECRET,
      ...init.headers,
    },
  });
}

export async function callApplicationsApi<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  init: ApiInit = {},
): Promise<z.output<TSchema>> {
  const response = await rawApplicationsApi(path, init);
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const refusal = apiMessageSchema.safeParse(body);

    throw new Error(
      refusal.success
        ? refusal.data.message
        : `Proton's API did not answer (HTTP ${response.status}). Nothing was changed. Try ` +
            'again in a moment.',
    );
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw new Error(
      `Proton's API sent a reply this page couldn't read. Reload the page and try again. (${path}: ` +
        `${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')})`,
    );
  }

  return parsed.data;
}
