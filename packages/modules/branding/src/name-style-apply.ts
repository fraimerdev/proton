import type {
  ActionExecutor,
  ActionResult,
  BotNameStyle,
  BrandingNameStyleStore,
  Logger,
  NameStyleOutcome,
  NameStyleReason,
  RestProxyClient,
} from '@proton/core';
import { z } from 'zod';
import { BRANDING_ACTOR, MODULE_ID } from './config.ts';
import { sameWireStyle } from './name-style.ts';

export { sameWireStyle } from './name-style.ts';

export const UNVERIFIED_RETRY_MS = 15 * 60_000;

const wireStyleSchema = z.object({
  font_id: z.number().int(),
  effect_id: z.number().int(),
  colors: z.array(z.number().int()),
});

export function readDisplayNameStyles(member: unknown): BotNameStyle | null | undefined {
  if (typeof member !== 'object' || member === null || !('display_name_styles' in member)) {
    return undefined;
  }

  const raw = member.display_name_styles;
  if (raw === null) return null;

  const parsed = wireStyleSchema.safeParse(raw);
  if (!parsed.success) return undefined;

  const { font_id, effect_id, colors } = parsed.data;
  return { fontId: font_id, effectId: effect_id, colours: colors };
}

export async function fetchBotNameStyle(
  rest: RestProxyClient,
  guildId: string,
  botUserId: string,
): Promise<BotNameStyle | null | undefined> {
  try {
    const response = await rest.request({
      method: 'GET',
      path: `/guilds/${guildId}/members/${botUserId}`,
    });
    return response.status === 200 ? readDisplayNameStyles(response.body) : undefined;
  } catch {
    return undefined;
  }
}

interface Judgement {
  outcome: NameStyleOutcome;
  reason: NameStyleReason | null;
}

function judge(outcome: NameStyleOutcome, reason: NameStyleReason | null): Judgement {
  return { outcome, reason };
}

const proxyFailureSchema = z.object({
  error: z.literal('rest_proxy_upstream_failure'),
  message: z.string(),
});

const MISSING_PERMISSION = /^Missing (Permissions|Access)/;

const DISCORD_REFUSAL = /^(Invalid Form Body|Unknown |\d{5}: |\S*\[[A-Z0-9_]+\]: )/;

function refusal(upstream: ActionResult['upstream']): Judgement {
  if (!upstream) return judge('unverified', 'no_answer');

  const { status, body } = upstream;
  if (status === 403) return judge('rejected', 'missing_change_nickname');
  if (status >= 400 && status < 500 && status !== 429) return judge('rejected', 'discord_refused');
  if (status !== 502) return judge('unverified', 'no_answer');

  const proxied = proxyFailureSchema.safeParse(body);
  if (!proxied.success) return judge('unverified', 'no_answer');

  const { message } = proxied.data;
  if (MISSING_PERMISSION.test(message)) return judge('rejected', 'missing_change_nickname');
  if (DISCORD_REFUSAL.test(message)) return judge('rejected', 'discord_refused');
  return judge('unverified', 'no_answer');
}

export async function verifyNameStyle(input: {
  guildId: string;
  botUserId: string | undefined;
  requested: BotNameStyle | null;
  result: ActionResult;
  rest: RestProxyClient | undefined;
}): Promise<Judgement> {
  const { result } = input;

  if (result.status === 'failed_precheck') {
    return result.failure?.code === 'missing_permission'
      ? judge('rejected', 'missing_change_nickname')
      : judge('unverified', 'no_answer');
  }

  if (result.status === 'failed_api') {
    return result.failure?.code === 'transport_failure'
      ? judge('unverified', 'no_answer')
      : refusal(result.upstream);
  }

  if (result.status !== 'executed') return judge('unverified', 'no_answer');

  let seen = readDisplayNameStyles(result.body);
  if (seen === undefined && input.rest && input.botUserId) {
    seen = await fetchBotNameStyle(input.rest, input.guildId, input.botUserId);
  }

  if (seen === undefined) return judge('unverified', 'not_readable');

  return sameWireStyle(seen, input.requested)
    ? judge('confirmed', null)
    : judge('ignored', 'discord_ignored');
}

export interface NameStyleVerdict {
  outcome: NameStyleOutcome;
  reason: NameStyleReason | null;
  recorded: boolean;
}

const WARNINGS: Record<NameStyleReason, string> = {
  missing_change_nickname:
    'Proton could not set its display name style in this server because it needs the Change Nickname permission here.',
  discord_refused:
    'Discord did not accept the display name style Proton sent in this server. Choose another style in the Branding module.',
  discord_ignored:
    'Discord answered but kept its old display name style for Proton in this server, so it does not accept this combination. Choose another style in the Branding module.',
  no_answer:
    'Proton could not confirm its display name style with Discord in this server because Discord did not answer. It will check again when the server next reconnects.',
  not_readable:
    'Discord took the display name style Proton sent in this server but did not say what it now shows, so Proton could not confirm it.',
  changed_in_discord:
    'The display name style Discord shows for Proton in this server is not the one Proton last confirmed.',
};

export async function applyNameStyle(
  ctx: { guildId: string; executor: ActionExecutor; logger: Logger },
  deps: { nameStyles: BrandingNameStyleStore; rest?: RestProxyClient; botUserId?: string },
  requested: BotNameStyle | null,
  idempotencyKey: string,
  now: () => number = () => Date.now(),
): Promise<NameStyleVerdict | null> {
  const meta = { guildId: ctx.guildId, moduleId: MODULE_ID };

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'set_bot_name_style',
    actorId: BRANDING_ACTOR,
    payload: { style: requested },
    dryRun: false,
    record: false,
    idempotencyKey,
  });

  if (result.status === 'skipped_duplicate') return null;

  // Nothing was sent and the key was never claimed, so recording this would stop the retry.
  if (result.status === 'failed_precheck' && result.failure?.code !== 'missing_permission') {
    ctx.logger.warn(
      `Proton did not send its display name style in this server yet: ${result.failure?.humanReason ?? 'it could not check what it may do here.'}`,
      meta,
    );
    return { outcome: 'unverified', reason: 'no_answer', recorded: false };
  }

  const verdict = await verifyNameStyle({
    guildId: ctx.guildId,
    botUserId: deps.botUserId,
    requested,
    result,
    rest: deps.rest,
  });

  await deps.nameStyles.recordAttempt({
    guildId: ctx.guildId,
    requested,
    outcome: verdict.outcome,
    reason: verdict.reason,
    at: now(),
  });

  if (verdict.reason !== null) ctx.logger.warn(WARNINGS[verdict.reason], meta);

  return { ...verdict, recorded: true };
}
