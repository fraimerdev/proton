import type { ModuleRegistry } from '@proton/core';
import { Hono } from 'hono';
import { z } from 'zod';
import { ModuleConfigError, type ModuleConfigService } from './modules/service.ts';

const updateBodySchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  actorId: z.string().min(1),
  source: z.enum(['dashboard', 'command', 'system']).default('dashboard'),
  ipHash: z.string().optional(),
});

export interface ApiDeps {
  modules: ModuleConfigService;
  registry: ModuleRegistry;
  sharedSecret: string;
}

/**
 * All domain logic lives behind this service (PLAN.md §9). Dashboard server
 * functions are thin authenticate → authorise → audit → delegate wrappers, so
 * the worker and the dashboard share one definition of every operation.
 */
export function createApiApp(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  // Service-to-service only. The browser never talks to this app.
  app.use('/guilds/*', async (c, next) => {
    if (c.req.header('x-proton-secret') !== deps.sharedSecret) {
      return c.json({ error: 'unauthorised' }, 401);
    }
    return next();
  });

  app.get('/guilds/:guildId/modules', (c) => {
    const modules = deps.registry.all().map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      descriptors: deps.registry.descriptors(m.id),
    }));
    return c.json({ modules });
  });

  app.get('/guilds/:guildId/modules/:moduleId', async (c) => {
    try {
      const view = await deps.modules.get(c.req.param('guildId'), c.req.param('moduleId'));
      return c.json(view);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  app.post('/guilds/:guildId/modules/:moduleId', async (c) => {
    const parsed = updateBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }

    try {
      const result = await deps.modules.update({
        guildId: c.req.param('guildId'),
        moduleId: c.req.param('moduleId'),
        ...parsed.data,
      });
      return c.json(result);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  return app;
}

/** Map a thrown error to a status and body, without needing Hono's context type. */
function toErrorResponse(error: unknown): {
  status: 400 | 404 | 500;
  body: { error: string; message?: string };
} {
  if (error instanceof ModuleConfigError) {
    return {
      status: error.code === 'unknown_module' ? 404 : 400,
      body: { error: error.code, message: error.message },
    };
  }
  return { status: 500, body: { error: 'internal_error' } };
}
