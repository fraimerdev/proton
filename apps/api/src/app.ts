import { caseQuerySchema, leaderboardQuerySchema, type ModuleRegistry } from '@proton/core';
import { Hono } from 'hono';
import { z } from 'zod';
import type { CaseQueryService } from './cases/service.ts';
import type { GuildService } from './guilds/service.ts';
import type { LeaderboardService } from './leveling/service.ts';
import { ModuleConfigError, type ModuleConfigService } from './modules/service.ts';

const updateBodySchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  actorId: z.string().min(1),
  source: z.enum(['dashboard', 'command', 'system']).default('dashboard'),
  ipHash: z.string().optional(),
});

const ensureGuildBodySchema = z.object({
  name: z.string().min(1),
  locale: z.string().optional(),
  shardId: z.number().int().min(0).optional(),
});

export interface ApiDeps {
  modules: ModuleConfigService;
  cases: CaseQueryService;
  leaderboard: LeaderboardService;
  guilds: GuildService;
  registry: ModuleRegistry;
  sharedSecret: string;
}

function parseCaseQuery(raw: Record<string, string>) {
  const numeric = (key: 'page' | 'pageSize') =>
    raw[key] === undefined ? {} : { [key]: Number(raw[key]) };

  return caseQuerySchema.safeParse({ ...raw, ...numeric('page'), ...numeric('pageSize') });
}

function parseLeaderboardQuery(raw: Record<string, string>) {
  const numeric = (key: 'page' | 'pageSize') =>
    raw[key] === undefined ? {} : { [key]: Number(raw[key]) };

  return leaderboardQuerySchema.safeParse({ ...numeric('page'), ...numeric('pageSize') });
}

function invalidQuery(error: z.ZodError): { error: string; message: string } {
  return {
    error: 'invalid_query',
    message: error.issues
      .map((i) => `${i.path.map(String).join('.') || 'query'}: ${i.message}`)
      .join('; '),
  };
}

export function createApiApp(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.put('/guilds/:guildId', async (c) => {
    if (c.req.header('x-proton-secret') !== deps.sharedSecret) {
      return c.json({ error: 'unauthorised' }, 401);
    }

    const parsed = ensureGuildBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }

    await deps.guilds.ensureGuild({ guildId: c.req.param('guildId'), ...parsed.data });
    return c.json({ ok: true });
  });

  app.delete('/guilds/:guildId', async (c) => {
    if (c.req.header('x-proton-secret') !== deps.sharedSecret) {
      return c.json({ error: 'unauthorised' }, 401);
    }

    await deps.guilds.markLeft(c.req.param('guildId'));
    return c.json({ ok: true });
  });

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

      commands: (m.commands ?? []).map((command) => command.name),
    }));
    return c.json({ modules });
  });

  app.get('/guilds/:guildId/cases', async (c) => {
    const parsed = parseCaseQuery(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_query',
          message: parsed.error.issues
            .map((i) => `${i.path.map(String).join('.') || 'query'}: ${i.message}`)
            .join('; '),
        },
        400,
      );
    }

    return c.json(await deps.cases.search(c.req.param('guildId'), parsed.data));
  });

  app.get('/guilds/:guildId/leaderboard', async (c) => {
    const parsed = parseLeaderboardQuery(c.req.query());
    if (!parsed.success) return c.json(invalidQuery(parsed.error), 400);

    return c.json(await deps.leaderboard.search(c.req.param('guildId'), parsed.data));
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
