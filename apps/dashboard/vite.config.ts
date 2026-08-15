import { fileURLToPath } from 'node:url';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Secrets live in one .env at the repo root. Vite defaults envDir to the Vite
// root (apps/dashboard), so without this the dashboard boots with no Discord
// credentials while every other service has them — a confusing half-start.
const envDir = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // envDir alone only feeds `import.meta.env`, and only VITE_-prefixed keys.
  // Server-side code (better-auth, drizzle, the API client) validates
  // `process.env` at import time, so load the root .env into it here — this is
  // the equivalent of the `bun --env-file=../../.env` every other app uses.
  // A real environment variable always wins over the file.
  for (const [key, value] of Object.entries(loadEnv(mode, envDir, ''))) {
    process.env[key] ??= value;
  }

  return {
    envDir,
    server: { port: 3000 },
    resolve: { tsconfigPaths: true },
    plugins: [
      tanstackStart(),
      // React's plugin must come after Start's.
      viteReact(),
    ],
  };
});
