import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
// Deliberately outside src/, so tsconfig never tries to resolve this build artefact — it does not
// exist until `bun run build`, and the bundle it points at exports a fetch handler that never listens.
import handler from './dist/server/server.js';

const CLIENT_DIR = fileURLToPath(new URL('./dist/client/', import.meta.url));

function clientFile(pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relative = normalize(decoded).replace(/^[/\\]+/, '');
  if (!relative || relative === '.' || relative.startsWith('..')) return null;

  return Bun.file(join(CLIENT_DIR, relative));
}

async function staticResponse(request: Request): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;

  const { pathname } = new URL(request.url);
  const file = clientFile(pathname);
  if (!file || !(await file.exists())) return null;

  const headers: Record<string, string> = {
    'content-type': file.type,
    'cache-control': pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600',
  };

  if (request.method === 'HEAD') {
    return new Response(null, { headers: { ...headers, 'content-length': String(file.size) } });
  }

  return new Response(file, { headers });
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? '127.0.0.1',
  idleTimeout: 60,
  fetch: async (request) => (await staticResponse(request)) ?? handler.fetch(request),
});

console.log(`dashboard listening on ${server.hostname}:${server.port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.stop(true).then(() => process.exit(0));
  });
}
