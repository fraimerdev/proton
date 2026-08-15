import { createDb } from '@proton/db';
import { createModuleRegistry } from '@proton/modules';
import { createApiApp } from './app.ts';
import { CaseQueryService } from './cases/service.ts';
import { loadEnv } from './env.ts';
import { ModuleConfigService } from './modules/service.ts';

const env = loadEnv();

const handle = createDb(env.DATABASE_URL);

// One shared list, so the API can never offer a module the worker does not run.
const registry = createModuleRegistry();

const app = createApiApp({
  modules: new ModuleConfigService(handle, registry),
  cases: new CaseQueryService(handle),
  registry,
  sharedSecret: env.API_SHARED_SECRET,
});

const server = Bun.serve({ port: env.PORT, fetch: app.fetch });
console.log(`api listening on :${server.port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      await server.stop(true);
      await handle.close();
      process.exit(0);
    })();
  });
}
