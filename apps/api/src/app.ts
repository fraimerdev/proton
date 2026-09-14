import {
  appealLinkClaimsSchema,
  BLOCK_REASON_MAX,
  type BrandingNameStyleStore,
  blockedMemberQuerySchema,
  caseQuerySchema,
  type EventBus,
  leaderboardQuerySchema,
  type ModuleIndex,
  type ModuleRegistry,
  type RegistryEnvironment,
  snowflakeSchema,
} from '@proton/core';
import type { MaintenanceStore } from '@proton/module-antinuke';
import { brandingConfigSchema } from '@proton/module-branding/config';
import { isAssetKind } from '@proton/module-branding/kinds';
import { describeNameStyleStatus } from '@proton/module-branding/name-style-status';
import { tagQuerySchema } from '@proton/module-tags/query';
import { ticketQuerySchema, ticketStatsQuerySchema } from '@proton/module-tickets/query';
import { Hono } from 'hono';
import { z } from 'zod';
import { AppealsError, type AppealsService } from './appeals/service.ts';
import { BrandingAssetError, type BrandingAssetService } from './branding/service.ts';
import { type CardPreviewService, cardPreviewQuerySchema } from './cards/preview.ts';
import type { CaseQueryService } from './cases/service.ts';
import type { GuildService } from './guilds/service.ts';
import type { LeaderboardService } from './leveling/service.ts';
import { XpEventError, type XpEventService, xpEventStartBodySchema } from './leveling/xp-events.ts';
import { BlockedMemberError, type BlockedMemberService } from './moderation/blocked-members.ts';
import { ModuleConfigError, type ModuleConfigService } from './modules/service.ts';
import type { TagSearchService } from './tags/service.ts';
import type { TicketSearchService } from './tickets/service.ts';
import { VerificationError, type VerificationService } from './verification/service.ts';

const updateBodySchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  actorId: z.string().min(1),
  source: z.enum(['dashboard', 'command', 'system']).default('dashboard'),
  ipHash: z.string().optional(),
});

// The panel is named in the path; the body carries only who asked, exactly as a config write does.
const postPanelBodySchema = z.object({
  actorId: z.string().min(1),
  source: z.enum(['dashboard', 'command', 'system']).default('dashboard'),
  ipHash: z.string().optional(),
});

// Discord answers /users/@me/guilds with at most 200, and the dashboard asks about the subset of
// those the signed-in user administers — so a longer list is a caller bug, not a big server.
const presenceBodySchema = z.object({
  ids: z.array(z.string().min(1)).max(200),
});

// Names Discord as the source on purpose: the other way this check can end is an unreachable
// Discord, and that one lets the write through, so an admin who sees this has been told the
// question was actually asked and answered.
const ABSENT = {
  error: 'bot_absent',
  message:
    'Discord says Proton is not in this server, so nothing was saved — a setting stored here ' +
    'would never reach Discord. Invite Proton back to the server and try again.',
} as const;

const ensureGuildBodySchema = z.object({
  name: z.string().min(1),
  locale: z.string().optional(),
  shardId: z.number().int().min(0).optional(),
});

const passedBodySchema = z.object({
  userId: snowflakeSchema,
  jti: z.string().min(1).max(64),
});

const appealFormBodySchema = z.object({ claims: appealLinkClaimsSchema });

const appealSubmitBodySchema = z.object({
  claims: appealLinkClaimsSchema,
  answers: z.record(z.string(), z.string()),
});

const liftBlockBodySchema = z.object({
  actorId: snowflakeSchema,
  source: z.string().min(1).max(32),
  liftReason: z.string().trim().min(1).max(BLOCK_REASON_MAX),
  ipHash: z.string().min(1).max(128).optional(),
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
  xpEvents: XpEventService;
  tags: TagSearchService;
  tickets: TicketSearchService;
  guilds: GuildService;
  verification: VerificationService;
  blocked: BlockedMemberService;
  appeals: AppealsService;
  branding: BrandingAssetService;
  brandingNameStyles: BrandingNameStyleStore;
  registry: ModuleRegistry;

  // Anti-nuke's maintenance window lives in Redis, written by the command that opens it. The
  // dashboard has to be able to say the breaker is suspended and to close the window early;
  // absent a Redis client the routes answer 503 rather than claiming protection is active.
  maintenance?: MaintenanceStore;
  bus?: EventBus;
  // What the bot actually has, for `registry.evaluate`. A function because intents come from the
  // gateway's identify and permissions from the guild, neither of which is known at construction.
  environment?: () => RegistryEnvironment;
  logger?: Pick<Console, 'warn'>;
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
  const logger = deps.logger ?? console;

  app.get('/healthz', (c) => c.json({ ok: true }));

  // The permission set an invite has to ask Discord for, unioned over every loaded module. It is
  // deployment-wide rather than per-guild, which is why it sits outside the /guilds/* tree — and it
  // is computed here because the registry is the only thing that knows which modules are loaded.
  app.get('/invite', (c) => {
    if (c.req.header('x-proton-secret') !== deps.sharedSecret) {
      return c.json({ error: 'unauthorised' }, 401);
    }

    return c.json({ permissions: deps.registry.invitePermissions().toString() });
  });

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

  // The dashboard's check asks whether the signed-in user administers the guild, never whether
  // Proton is still in it, so a stale guilds row — which satisfies guild_modules' foreign key —
  // let every save succeed into a server the bot had been kicked from. Writes only: the page for
  // that server still has to load far enough to say so.
  app.use('/guilds/*', async (c, next) => {
    if (c.req.method === 'GET') return next();

    // Split rather than `/guilds/:guildId/*`, whose trailing wildcard also matches the empty rest
    // and so reads `/guilds/presence` — the question itself — as a guild named "presence".
    const [, , guildId, nested] = c.req.path.split('/');
    if (!guildId || !nested) return next();

    const { present, known } = await deps.guilds.presence([guildId]);

    // Allowed, deliberately: `known:false` outlives the directory's ten-minute grace window, so it
    // is a sustained outage, and refusing would make every server's settings read-only for its
    // duration to stop a row that is inert until the bot is back. Only a checked absence refuses,
    // which is the call the guild route loader already makes.
    if (!known) {
      logger.warn(
        `Proton could not check whether it is still in ${guildId}, so a ${c.req.method} on ` +
          `${c.req.path} was allowed through unverified.`,
      );
      return next();
    }

    if (!present.includes(guildId)) return c.json(ABSENT, 409);

    return next();
  });

  // Which of the caller's servers Proton is actually in, answered from Discord's own list of the
  // bot's guilds. One round trip for the whole list: the picker renders every server the user
  // administers, and the user-scoped guild object Discord hands the dashboard cannot say.
  app.post('/guilds/presence', async (c) => {
    const parsed = presenceBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }

    return c.json(await deps.guilds.presence(parsed.data.ids));
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

  app.get('/guilds/:guildId/antinuke/maintenance', async (c) => {
    if (!deps.maintenance) {
      return c.json(
        {
          error: 'no_redis',
          message:
            'Proton cannot reach Redis, where the maintenance window is kept, so it cannot say ' +
            'whether anti-nuke is suspended. Set REDIS_URL for the api and restart it.',
        },
        503,
      );
    }

    const window = await deps.maintenance.get(c.req.param('guildId'));
    return c.json({ window: window ?? null, now: Date.now() });
  });

  // Closing the window early is a security decision, so it is recorded like a config write.
  app.delete('/guilds/:guildId/antinuke/maintenance', async (c) => {
    if (!deps.maintenance) {
      return c.json({ error: 'no_redis', message: 'Proton cannot reach Redis.' }, 503);
    }

    const actorId = c.req.header('x-proton-actor');
    if (!actorId) return c.json({ error: 'invalid_body', message: 'no actor was named' }, 400);

    const guildId = c.req.param('guildId');
    const held = await deps.maintenance.get(guildId);

    await deps.maintenance.clear(guildId);
    await deps.modules.recordMaintenanceEnded(guildId, actorId, held);

    return c.json({ ok: true, window: null });
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

  app.get('/guilds/:guildId/leveling/xp-events', async (c) => {
    return c.json(await deps.xpEvents.list(c.req.param('guildId')));
  });

  app.post('/guilds/:guildId/leveling/xp-events', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);

    const parsed = xpEventStartBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }

    try {
      return c.json(
        await deps.xpEvents.start({ guildId: c.req.param('guildId'), ...parsed.data, event: body }),
      );
    } catch (error) {
      const { status, body: refusal } = toErrorResponse(error);
      return c.json(refusal, status);
    }
  });

  app.delete('/guilds/:guildId/leveling/xp-events/:eventId', async (c) => {
    const actorId = c.req.header('x-proton-actor');
    if (!actorId) return c.json({ error: 'invalid_body', message: 'no actor was named' }, 400);

    try {
      return c.json(
        await deps.xpEvents.end({
          guildId: c.req.param('guildId'),
          eventId: c.req.param('eventId'),
          actorId,
        }),
      );
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  app.get('/guilds/:guildId/tags', async (c) => {
    const parsed = parseTagQuery(c.req.query());
    if (!parsed.success) {
      return c.json({ ...invalidQuery(parsed.error) }, 400);
    }

    return c.json(await deps.tags.search(c.req.param('guildId'), parsed.data));
  });

  app.get('/guilds/:guildId/tickets', async (c) => {
    const parsed = ticketQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json(invalidQuery(parsed.error), 400);

    return c.json(await deps.tickets.search(c.req.param('guildId'), parsed.data));
  });

  app.get('/guilds/:guildId/tickets/stats', async (c) => {
    const parsed = ticketStatsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json(invalidQuery(parsed.error), 400);

    return c.json(await deps.tickets.stats(c.req.param('guildId'), parsed.data));
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

  // The dashboard draws its own live preview from the same component, but only satori and resvg
  // turn that component into the PNG Discord actually receives, and neither runs in a browser.
  // This route is where a caller can ask for the bytes rather than a rendering of them.
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

  // Asked, not posted: this process has no Discord client, so it records the request and publishes
  // it for the worker. The response says which panel was asked for, and nothing about the send.
  app.post('/guilds/:guildId/modules/:moduleId/panels/:panelId/post', async (c) => {
    const parsed = postPanelBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }

    try {
      const result = await deps.modules.requestPanel({
        guildId: c.req.param('guildId'),
        moduleId: c.req.param('moduleId'),
        panelId: c.req.param('panelId'),
        ...parsed.data,
      });

      return c.json(result);
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  // The dashboard has already proved the signed-in session owns this user id; the api trusts it the
  // same way it trusts actorId on a config write, because both arrive over the shared secret.
  app.post('/guilds/:guildId/verification/passed', async (c) => {
    const parsed = passedBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }

    try {
      return c.json(
        await deps.verification.recordWebPass({
          guildId: c.req.param('guildId'),
          ...parsed.data,
        }),
      );
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  app.get('/guilds/:guildId/blocked-members', async (c) => {
    const parsed = blockedMemberQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json(invalidQuery(parsed.error), 400);

    try {
      return c.json(await deps.blocked.list(c.req.param('guildId'), parsed.data));
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  app.post('/guilds/:guildId/blocked-members/:userId/lift', async (c) => {
    const parsed = liftBlockBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }

    try {
      return c.json(
        await deps.blocked.lift({
          guildId: c.req.param('guildId'),
          userId: c.req.param('userId'),
          ...parsed.data,
        }),
      );
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  // The claims arrive already verified: only the dashboard holds VERIFY_LINK_SECRET, and it
  // reaches this route over the shared secret the same way a config write does.
  app.post('/guilds/:guildId/appeals/form', async (c) => {
    const parsed = appealFormBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }

    try {
      return c.json(await deps.appeals.form(parsed.data.claims));
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  app.post('/guilds/:guildId/appeals/submit', async (c) => {
    const parsed = appealSubmitBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }

    try {
      return c.json(await deps.appeals.submit(parsed.data.claims, parsed.data.answers));
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  app.get('/guilds/:guildId/branding/name-style/status', async (c) => {
    const guildId = c.req.param('guildId');

    try {
      const [view, state] = await Promise.all([
        deps.modules.get(guildId, 'branding'),
        deps.brandingNameStyles.get(guildId),
      ]);
      const config = brandingConfigSchema.parse(view.config);

      return c.json(
        describeNameStyleStatus({
          enabled: view.enabled && config.enabled,
          requested: config.displayNameStyle,
          state,
        }),
      );
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  app.get('/guilds/:guildId/branding/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (!isAssetKind(kind)) return c.json({ error: 'unknown_asset' }, 404);

    try {
      const asset = await deps.branding.read(c.req.param('guildId'), kind);
      return new Response(asset.bytes, {
        headers: {
          'content-type': asset.contentType,
          'cache-control': 'no-store',
          'content-length': String(asset.bytes.byteLength),
        },
      });
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  // Raw bytes on the wire, not base64 in JSON: the dashboard already holds a File, and base64 would
  // inflate a 2 MB banner by a third on every hop for nothing.
  app.put('/guilds/:guildId/branding/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (!isAssetKind(kind)) return c.json({ error: 'unknown_asset' }, 404);

    const actorId = c.req.header('x-proton-actor');
    if (!actorId) return c.json({ error: 'invalid_body', message: 'no actor was named' }, 400);

    try {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return c.json(
        await deps.branding.upload({ guildId: c.req.param('guildId'), kind, bytes, actorId }),
      );
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  app.delete('/guilds/:guildId/branding/:kind', async (c) => {
    const kind = c.req.param('kind');
    if (!isAssetKind(kind)) return c.json({ error: 'unknown_asset' }, 404);

    const actorId = c.req.header('x-proton-actor');
    if (!actorId) return c.json({ error: 'invalid_body', message: 'no actor was named' }, 400);

    try {
      await deps.branding.clear(c.req.param('guildId'), kind, actorId);
      return c.json({ ok: true });
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      return c.json(body, status);
    }
  });

  return app;
}

function toErrorResponse(error: unknown): {
  status: 400 | 404 | 409 | 500 | 503;
  body: { error: string; message?: string };
} {
  if (error instanceof XpEventError) {
    return {
      status:
        error.code === 'unknown_xp_event' ? 404 : error.code === 'too_many_xp_events' ? 409 : 400,
      body: { error: error.code, message: error.message },
    };
  }

  if (error instanceof ModuleConfigError) {
    return {
      status: error.code === 'unknown_module' ? 404 : 400,
      body: { error: error.code, message: error.message },
    };
  }

  if (error instanceof BrandingAssetError) {
    return {
      status: error.code === 'unknown_asset' ? 404 : 400,
      body: { error: error.code, message: error.message },
    };
  }

  if (error instanceof AppealsError) {
    return {
      status: error.code === 'bus_unavailable' ? 503 : 400,
      body: { error: error.code, message: error.message },
    };
  }

  if (error instanceof BlockedMemberError) {
    return {
      status: error.code === 'not_blocked' ? 404 : 400,
      body: { error: error.code, message: error.message },
    };
  }

  if (error instanceof VerificationError) {
    return {
      status: error.code === 'bus_unavailable' ? 503 : 400,
      body: { error: error.code, message: error.message },
    };
  }

  return { status: 500, body: { error: 'internal_error' } };
}
