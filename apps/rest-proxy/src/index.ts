import { createProxyApp } from './app.ts';
import { loadEnv } from './env.ts';
import { createRest } from './rest.ts';

const env = loadEnv();
const rest = createRest({ token: env.DISCORD_BOT_TOKEN, api: env.DISCORD_API_URL });
const app = createProxyApp(rest);

const server = Bun.serve({ port: env.PORT, fetch: app.fetch });

console.log(`rest-proxy listening on :${server.port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.stop(true).then(() => process.exit(0));
  });
}
