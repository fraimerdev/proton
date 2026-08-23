import {
  caseQuerySchema,
  type EventBus,
  leaderboardQuerySchema,
  type ModuleIndex,
  type ModuleRegistry,
  type RegistryEnvironment,
} from '@proton/core';
import { tagQuerySchema } from '@proton/module-tags/query';
import { Hono } from 'hono';
import { z } from 'zod';
import { type CardPreviewService, cardPreviewQuerySchema } from './cards/preview.ts';
import type { CaseQueryService } from './cases/service.ts';
import type { GuildService } from './guilds/service.ts';
import type { LeaderboardService } from './leveling/service.ts';
import { ModuleConfigError, type ModuleConfigService } from './modules/service.ts';
import type { TagSearchService } from './tags/service.ts';

const updateBodySchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  actorId: z.string().min(1),
  source: z.enum(['dashboard', 'command', 'system']).default('dashboard'),
  ipHash: z.string().optional(),
});

// Discord answers /users/@me/guilds with at most 200, and the dashboard asks about the subset of
// those the signed-in user administers — so a longer list is a caller bug, not a big server.
const presenceBodySchema = z.object({
  ids: z.array(z.string().min(1)).max(200),
});

const ensureGuildBodySchema = z.object({
  name: z.string().min(1),
  locale: z.string().optional(),
  shardId: z.number().int().min(0).optional(),
});

export function moduleIndex(
  registry: ModuleRegistry,
  switches: Record<string, boolean>,
  environment?: RegistryEnvironment,
): ModuleIndex {
  return {
    modules: registry.all().map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,

      // Path and label only: the full descriptors are 41 kB across the 27 installed modules and
      // the index is read on every guild page load, while a form only ever needs one module's.
      fields: registry.descriptors(m.id).map(({ path, label }) => ({ path, label })),

      commands: (m.commands ?? []).map((command) => command.name),
      // The guild's own switch, which `status` is not: a module can be switched on here and still
      // be unable to run, and the overview exists to show exactly that gap.
      enabled: switches[m.id] ?? false,
      // Both were populated by every module and read by nobody. Without `dashboard` the settings
      // page is one undifferentiated wall of fields, and without `status` §7's promise that a
      // module says why it is disabled was never kept.
      dashboard: m.dashboard ?? null,
      status: environment ? registry.evaluate(m.id, environment) : null,
    })),
  };
}

export interface ApiDeps {
  modules: ModuleConfigService;
  cards: CardPreviewService;
  cases: CaseQueryService;
  leaderboard: LeaderboardService;
  tags: TagSearchService;
  guilds: GuildService;
  registry: ModuleRegistry;
  bus?: EventBus;
  // What the bot actually has, for `registry.evaluate`. A function because intents come from the
  // gateway's identify and permissions from the guild, neither of which is known at construction.
  environment?: () => RegistryEnvironment;
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

function parseTagQuery(raw: Record<string, string>) {
  return tagQuerySchema.safeParse(raw);
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

  // Which of the caller's servers Proton is actually in. One round trip for the whole list: the
  // picker renders every server the user administers, and Discord's own guild object cannot say.
  app.post('/guilds/presence', async (c) => {
    const parsed = presenceBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }

    return c.json({ present: await deps.guilds.presentIds(parsed.data.ids) });
  });

  // Proton's own row, not Discord's: the dashboard already has the Discord guild object from the
  // session, and what it cannot see is when Proton joined and which tier this server is on.
  app.get('/guilds/:guildId', async (c) => {
    const overview = await deps.guilds.overview(c.req.param('guildId'));
    if (!overview) return c.json({ error: 'unknown_guild' }, 404);

    return c.json(overview);
  });

  app.get('/guilds/:guildId/modules', async (c) => {
    const switches = await deps.modules.enabledMap(c.req.param('guildId'));

    return c.json(
      moduleIndex(deps.registry, switches, deps.environment ? deps.environment() : undefined),
    );
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

  app.get('/guilds/:guildId/tags', async (c) => {
    const parsed = parseTagQuery(c.req.query());
    if (!parsed.success) {
      return c.json({ ...invalidQuery(parsed.error) }, 400);
    }

    return c.json(await deps.tags.search(c.req.param('guildId'), parsed.data));
  });

  // Guild-independent — the descriptors come from the deployed registry, not from this guild's
  // row — but mounted under /guilds so it inherits the shared-secret guard above.
  app.get('/guilds/:guildId/modules/:moduleId/descriptors', (c) => {
    const moduleId = c.req.param('moduleId');
    if (!deps.registry.get(moduleId)) return c.json({ error: 'unknown_module' }, 404);

    return c.json({ moduleId, descriptors: deps.registry.descriptors(moduleId) });
  });

  // The picker the in-Discord builder and the dashboard both read: a provider whose owning
  // module is switched off in this guild is not offered, so nothing can be configured that could
  // never be evaluated.
  app.get('/guilds/:guildId/providers', async (c) => {
    const guildId = c.req.param('guildId');

    try {
      const enabled = await deps.modules.enabledMap(guildId);

      const providers = await deps.registry.availableProviders(guildId, {
        async isEnabled(_guildId, moduleId) {
          return enabled[moduleId] === true;
        },
      });

      return c.json({ guildId, providers });
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
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

  // Rendered here rather than in the dashboard because the renderer is a native addon: this is the
  // same code path that draws the real card, so a preview cannot drift from what Discord receives.
  app.get('/guilds/:guildId/cards/preview', async (c) => {
    const parsed = cardPreviewQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(invalidQuery(parsed.error), 400);
    }

    try {
      const png = await deps.cards.render(parsed.data);
      return new Response(png, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': String(png.byteLength),
        },
      });
    } catch (error) {
      return c.json(
        {
          error: 'preview_failed',
          message: error instanceof Error ? error.message : 'the card could not be rendered',
        },
        400,
      );
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
