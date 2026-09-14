import {
  type EntitlementTier,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  toDiscordMessage,
  type V2Component,
} from '@proton/core';
import {
  type BotFacts,
  renderMessageTemplate,
  type ServerFacts,
  type UserFacts,
} from '@proton/core/placeholders';
import type { HoneypotConfig } from './config.ts';
import { APPEAL_KEY, INVITE_KEY } from './layout.ts';
import { DM_ACTION_WORD, layoutFor, RECOVERY_ADVICE_TEXT } from './notice.ts';
import {
  HONEYPOT_DM_SURFACE,
  type HoneypotDmFacts,
  layoutPlaceholderKeys,
} from './placeholders.ts';

export interface DmFacts {
  guildName: string;
  appealUrl?: string | undefined;
  server?: ServerFacts | null | undefined;
  user?: UserFacts | null | undefined;
  bot?: BotFacts | null | undefined;
}

export type RenderedMessage =
  | { ok: true; components: Record<string, unknown>[]; flags: number }
  | { ok: false; humanReason: string };

function linkRow(
  buttons: ReadonlyArray<{ key: string; label: string; url: string }>,
): V2Component | null {
  if (buttons.length === 0) return null;

  return {
    kind: 'row',
    row: {
      kind: 'buttons',
      buttons: buttons.map((button) => ({ ...button, style: 'link' as const })),
    },
  };
}

function appendTo(v2: readonly V2Component[], extra: readonly V2Component[]): V2Component[] {
  if (extra.length === 0) return [...v2];

  const last = v2.findLastIndex((component) => component.kind === 'container');
  if (last === -1) return [...v2, ...extra];

  return v2.map((component, index) => {
    if (index !== last || component.kind !== 'container') return component;

    return { ...component, children: [...component.children, ...(extra as never[])] };
  });
}

export function dmPlaceholderFacts(config: HoneypotConfig, facts: DmFacts): HoneypotDmFacts {
  return {
    action: DM_ACTION_WORD[config.action],
    guildName: facts.guildName,
    server: facts.server ?? null,
    user: facts.user ?? null,
    bot: facts.bot ?? null,

    // Only on a ban. Softban, kick, timeout and warn all leave a way back in already, so an appeal
    // button on one of those invites a member to appeal something that is not stopping them.
    ...(facts.appealUrl && config.action === 'ban' ? { appealUrl: facts.appealUrl } : {}),
    ...(config.offerWayBackIn && config.inviteUrl ? { inviteUrl: config.inviteUrl } : {}),
  };
}

export function dmPlaceholderKeys(
  config: HoneypotConfig,
  tier: EntitlementTier | undefined,
): Set<string> {
  return layoutPlaceholderKeys(HONEYPOT_DM_SURFACE, layoutFor(config, 'dmLayout', tier));
}

/**
 * The direct message, resolved for one recipient. The appeal and rejoin buttons are appended here
 * rather than stored in the layout: their addresses differ per recipient, and a stored non-link
 * button would have to carry a ComponentAction Proton has no handler for.
 */
export function renderDirectMessage(
  config: HoneypotConfig,
  tier: EntitlementTier | undefined,
  facts: DmFacts,
  now: number = Date.now(),
): RenderedMessage {
  const placeholders = dmPlaceholderFacts(config, facts);

  const rendered = renderMessageTemplate(
    layoutFor(config, 'dmLayout', tier),
    HONEYPOT_DM_SURFACE,
    HONEYPOT_DM_SURFACE.build(placeholders, { now }),
    { now, basePath: 'dmLayout' },
  );
  if (!rendered.ok) return { ok: false, humanReason: rendered.humanReason };

  const extra: V2Component[] = [];

  extra.push({ kind: 'separator', divider: true, spacing: 'small' });
  extra.push({ kind: 'text', content: RECOVERY_ADVICE_TEXT });

  const buttons: Array<{ key: string; label: string; url: string }> = [];

  if (placeholders.appealUrl) {
    buttons.push({ key: APPEAL_KEY, label: 'Appeal', url: placeholders.appealUrl });
  }

  if (placeholders.inviteUrl) {
    buttons.push({ key: INVITE_KEY, label: 'Rejoin', url: placeholders.inviteUrl });
  }

  const row = linkRow(buttons);
  if (row) extra.push(row);

  const message = toDiscordMessage(
    { ...rendered.message, v2: appendTo(rendered.message.v2, extra) },
    { customIdFor: (key) => key },
  );

  return {
    ok: true,
    components: (message.components ?? []) as unknown as Record<string, unknown>[],
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
  };
}
