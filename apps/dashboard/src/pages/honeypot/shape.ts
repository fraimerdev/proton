import type { EntitlementTier, MessageButton, ProtonMessage, V2Component } from '@proton/core';
import { substitute } from '@proton/core';
import type { HoneypotConfig } from '@proton/module-honeypot/config';
import {
  APPEAL_KEY,
  COUNTER_KEY,
  HONEYPOT_POT,
  INVITE_KEY,
  QUIET_NOTICE_BODY,
  RECOVERY_ADVICE,
} from '@proton/module-honeypot/layout';
import {
  appendRow,
  caughtLabel,
  consequenceOf,
  DM_ACTION_WORD,
  layoutFor,
  purgeSentence,
} from '@proton/module-honeypot/notice';
import type { ModuleForm } from '../../components/module/form.ts';

export type HoneypotForm = ModuleForm<HoneypotConfig>;

export interface ConfigErrors {
  at: (path: string) => string | undefined;
  under: (path: string) => string | undefined;
}

export function configErrors(form: HoneypotForm): ConfigErrors {
  return {
    at: form.errorAt,
    under: (path) => {
      for (const [key, message] of form.errors) {
        if (key === path || key.startsWith(`${path}.`)) return message;
      }
      return undefined;
    },
  };
}

export function armedChannelIds(config: HoneypotConfig): string[] {
  return config.channels.filter((channel) => channel.enabled).map((channel) => channel.channelId);
}

/**
 * Which text display "Hide channel purpose" overwrites: the second one in the first container
 * that holds two. Kept in step with replaceBody in the module, which walks containers in order and
 * leaves one with a single text display alone rather than stopping at it.
 */
export function overriddenBodyPath(v2: readonly V2Component[]): string | undefined {
  for (const [index, component] of v2.entries()) {
    if (component.kind !== 'container') continue;

    let seen = 0;
    for (const [at, child] of component.children.entries()) {
      if (child.kind !== 'text') continue;
      seen += 1;
      if (seen === 2) return `${index}.children.${at}`;
    }
  }

  return undefined;
}

function replaceBody(v2: readonly V2Component[], body: string): V2Component[] {
  const target = overriddenBodyPath(v2);
  if (target === undefined) return [...v2];

  const [index, , at] = target.split('.');

  return v2.map((component, position) => {
    if (component.kind !== 'container' || String(position) !== index) return component;

    return {
      ...component,
      children: component.children.map((child, childAt) =>
        String(childAt) === at && child.kind === 'text' ? { ...child, content: body } : child,
      ),
    };
  });
}

export function noticeVariables(config: HoneypotConfig): Record<string, string> {
  return { consequence: consequenceOf(config.action), purge: purgeSentence(config) };
}

/** What buildNoticeComponents posts, in Proton's own vocabulary so DiscordPreview can draw it. */
export function noticePreview(
  config: HoneypotConfig,
  tier: EntitlementTier,
  caught: number,
): V2Component[] {
  const vars = noticeVariables(config);
  const substituted = substitute(layoutFor(config, 'noticeLayout', tier), vars) as ProtonMessage;

  const withBody = config.hideWhatIsAHoneypot
    ? replaceBody(substituted.v2, substitute(QUIET_NOTICE_BODY, vars) as string)
    : substituted.v2;

  if (!config.noticeCounterButton) return withBody;

  return appendRow(withBody, {
    kind: 'row',
    row: {
      kind: 'buttons',
      buttons: [
        {
          key: COUNTER_KEY,
          style: 'secondary',
          label: caughtLabel(config.action, caught),
          emoji: { name: HONEYPOT_POT },
        },
      ],
    },
  });
}

export function quietNoticeBody(config: HoneypotConfig): string {
  return substitute(QUIET_NOTICE_BODY, noticeVariables(config)) as string;
}

export function dmVariables(config: HoneypotConfig, guildName: string): Record<string, string> {
  return { server: guildName, action: DM_ACTION_WORD[config.action] };
}

export function dmOffersAppeal(config: HoneypotConfig): boolean {
  return config.action === 'ban' && (config.appealPanelId ?? '') !== '';
}

/** What renderDirectMessage sends, minus the per-recipient appeal address Proton mints at send. */
export function dmPreview(
  config: HoneypotConfig,
  tier: EntitlementTier,
  guildName: string,
): V2Component[] {
  const substituted = substitute(
    layoutFor(config, 'dmLayout', tier),
    dmVariables(config, guildName),
  ) as ProtonMessage;

  const extra: V2Component[] = [
    { kind: 'separator', divider: true, spacing: 'small' },
    { kind: 'text', content: RECOVERY_ADVICE },
  ];

  const buttons: MessageButton[] = [];

  if (dmOffersAppeal(config)) {
    buttons.push({ key: APPEAL_KEY, style: 'link', label: 'Appeal', url: '' });
  }

  if (config.offerWayBackIn && config.inviteUrl) {
    buttons.push({ key: INVITE_KEY, style: 'link', label: 'Rejoin', url: config.inviteUrl });
  }

  if (buttons.length > 0) extra.push({ kind: 'row', row: { kind: 'buttons', buttons } });

  return extra.reduce<V2Component[]>(
    (carried, component) => appendRow(carried, component),
    [...substituted.v2],
  );
}
