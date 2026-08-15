import { fileURLToPath } from 'node:url';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const envDir = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  for (const [key, value] of Object.entries(loadEnv(mode, envDir, ''))) {
    process.env[key] ??= value;
  }

  return {
    envDir,
    server: { port: 3000 },
    resolve: { tsconfigPaths: true },
    plugins: [
      tanstackStart(),

      viteReact(),
    ],
  };
});
