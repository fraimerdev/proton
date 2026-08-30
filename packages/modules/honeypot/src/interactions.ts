import {
  type EventListener,
  type EventType,
  interactionRef,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  type ModuleContext,
  Permissions,
  type ProtonEvent,
  parseCustomId,
  readComponentInteraction,
  replyEphemeral,
} from '@proton/core';
import { type HoneypotConfig, MODULE_ID } from './config.ts';
import { describeUnbound, type HoneypotDeps } from './deps.ts';
import { buildStatsComponents, STATS_ACTION } from './notice.ts';

// Who a trap caught is not public information, and the notice sits in a channel everybody can see.
const PRIVILEGED = Permissions.BanMembers | Permissions.ManageGuild;

export type StatsOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'answered'; channelId: string; privileged: boolean };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function readPermissions(event: ProtonEvent): bigint {
  const raw = record(record(event.payload)?.member)?.permissions;
  if (typeof raw !== 'string') return 0n;

  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

export async function handleStatsPress(
  event: ProtonEvent,
  ctx: ModuleContext<HoneypotConfig>,
  deps: HoneypotDeps,
): Promise<StatsOutcome> {
  const facts = readComponentInteraction(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable interaction payload' };

  const parsed = parseCustomId(facts.customId);
  if (!parsed || parsed.moduleId !== MODULE_ID) {
    return { action: 'ignored', reason: 'another module owns that component' };
  }
  if (parsed.action !== STATS_ACTION) {
    return { action: 'ignored', reason: `no honeypot component called '${parsed.action}'` };
  }

  const channelId = parsed.args[0];
  if (!channelId) return { action: 'ignored', reason: 'the button carried no channel' };

  const to = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: facts.userId,
    interaction: interactionRef(facts),
    idempotencyKey: `${MODULE_ID}:${event.id}`,
  };

  const stats = deps.stats;
  if (!stats) {
    ctx.logger.error(describeUnbound('a honeypot stats press went unanswered', ['stats']), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });

    await ctx.executor.execute(
      replyEphemeral(to, 'I cannot read this trap’s numbers right now. Try again in a moment.'),
    );
    return { action: 'refused', reason: 'the stats port is unbound' };
  }

  const now = deps.now?.() ?? Date.now();

  const privileged = (readPermissions(event) & PRIVILEGED) !== 0n;
  const read = await stats.read(ctx.guildId, channelId, now);

  const result = await ctx.executor.execute(
    replyEphemeral(to, {
      components: buildStatsComponents({
        channelId,
        action: ctx.config.action,
        total: read.total,
        lastDay: read.lastDay,
        lastWeek: read.lastWeek,
        byAction: read.byAction,
        recent: read.recent,
        privileged,
      }),

      flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
      allowedMentions: { parse: [] },
    }),
  );

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    const reason = result.failure?.humanReason ?? 'no reason was reported';
    ctx.logger.warn(`honeypot could not answer a stats press: ${reason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      code: result.failure?.code,
    });
    return { action: 'refused', reason };
  }

  return { action: 'answered', channelId, privileged };
}

export const HONEYPOT_STATS_EVENT_TYPES: EventType[] = ['interaction.component'];

export function createHoneypotStatsListener(deps: HoneypotDeps): EventListener<HoneypotConfig> {
  return {
    types: HONEYPOT_STATS_EVENT_TYPES,
    async handler(event, ctx) {
      await handleStatsPress(event, ctx, deps);
    },
  };
}
