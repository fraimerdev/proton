import {
  type EntitlementTier,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
  type ProtonMessage,
  substitute,
  toDiscordMessage,
  type V2Component,
} from '@proton/core';
import type { HoneypotConfig } from './config.ts';
import { APPEAL_KEY, INVITE_KEY } from './layout.ts';
import { DM_ACTION_WORD, layoutFor, RECOVERY_ADVICE_TEXT } from './notice.ts';

export interface DmFacts {
  guildName: string;
  appealUrl?: string | undefined;
}

export interface RenderedMessage {
  components: Record<string, unknown>[];
  flags: number;
}

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

/**
 * The direct message, resolved for one recipient. The appeal and rejoin buttons are appended here
 * rather than stored in the layout: their addresses differ per recipient, and a stored non-link
 * button would have to carry a ComponentAction Proton has no handler for.
 */
export function renderDirectMessage(
  config: HoneypotConfig,
  tier: EntitlementTier | undefined,
  facts: DmFacts,
): RenderedMessage {
  const layout = layoutFor(config, 'dmLayout', tier);

  const substituted = substitute(layout, {
    server: facts.guildName,
    action: DM_ACTION_WORD[config.action],
  }) as ProtonMessage;

  const extra: V2Component[] = [];

  extra.push({ kind: 'separator', divider: true, spacing: 'small' });
  extra.push({ kind: 'text', content: RECOVERY_ADVICE_TEXT });

  const buttons: Array<{ key: string; label: string; url: string }> = [];

  // Only on a ban. Softban, kick, timeout and warn all leave a way back in already, so an appeal
  // button on one of those invites a member to appeal something that is not stopping them.
  if (facts.appealUrl && config.action === 'ban') {
    buttons.push({ key: APPEAL_KEY, label: 'Appeal', url: facts.appealUrl });
  }

  if (config.offerWayBackIn && config.inviteUrl) {
    buttons.push({ key: INVITE_KEY, label: 'Rejoin', url: config.inviteUrl });
  }

  const row = linkRow(buttons);
  if (row) extra.push(row);

  const rendered = toDiscordMessage(
    { ...substituted, v2: appendTo(substituted.v2, extra) },
    { customIdFor: (key) => key },
  );

  return {
    components: (rendered.components ?? []) as unknown as Record<string, unknown>[],
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
  };
}
