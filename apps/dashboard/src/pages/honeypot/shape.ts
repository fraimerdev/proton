import type { EntitlementTier, MessageButton, ProtonMessage, V2Component } from '@proton/core';
import type { PlaceholderSurface, SurfaceSample } from '@proton/core/placeholders';
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
  layoutFor,
  noticePlaceholderFacts,
} from '@proton/module-honeypot/notice';
import {
  HONEYPOT_DM_SURFACE,
  HONEYPOT_NOTICE_SURFACE,
  type HoneypotDmFacts,
  type HoneypotNoticeFacts,
} from '@proton/module-honeypot/placeholders';
import { dmPlaceholderFacts } from '@proton/module-honeypot/render';
import type { ModuleForm } from '../../components/module/form.ts';
import { type MentionNames, previewMessage, previewText } from '../../lib/placeholder-preview.ts';

export { type ConfigErrors, configErrors } from '../../components/discord/embed-editor.tsx';

export type HoneypotForm = ModuleForm<HoneypotConfig>;

export interface NoticePreview {
  v2: V2Component[] | null;
  caption: string;
  channelName: string | undefined;
  mentionNames: MentionNames;
  now: number;
}

export interface DmPreview {
  v2: V2Component[] | null;
  caption: string;
  builtIn: boolean;
  mentionNames: MentionNames;
  now: number;
}

const SAMPLE_APPEAL_URL = 'https://prtn.xyz/appeal/sample';

function sampleOf<F>(surface: PlaceholderSurface<F>): SurfaceSample<F> {
  const [sample] = surface.samples;
  if (sample === undefined) {
    throw new Error(`The ${surface.label} placeholders have no sample, so it cannot be previewed.`);
  }
  return sample;
}

const NOTICE_SAMPLE = sampleOf(HONEYPOT_NOTICE_SURFACE);

const DM_SAMPLE = sampleOf(HONEYPOT_DM_SURFACE);

export function armedChannelIds(config: HoneypotConfig): string[] {
  return config.channels.filter((channel) => channel.enabled).map((channel) => channel.channelId);
}

// Kept in step with replaceBody in the module: a container with one text display is passed over.
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

function noticeWording(config: HoneypotConfig): Pick<HoneypotNoticeFacts, 'consequence' | 'purge'> {
  const { channel, caught } = NOTICE_SAMPLE.facts;
  const { consequence, purge } = noticePlaceholderFacts(config, channel.id, caught);
  return { consequence, purge };
}

function noticeLayout(config: HoneypotConfig, tier: EntitlementTier): ProtonMessage {
  const layout = layoutFor(config, 'noticeLayout', tier);

  return config.hideWhatIsAHoneypot
    ? { ...layout, v2: replaceBody(layout.v2, QUIET_NOTICE_BODY) }
    : layout;
}

export function noticePreview(config: HoneypotConfig, tier: EntitlementTier): NoticePreview {
  const { channel, caught } = NOTICE_SAMPLE.facts;
  const rendered = previewMessage(
    HONEYPOT_NOTICE_SURFACE,
    noticeLayout(config, tier),
    NOTICE_SAMPLE,
    noticeWording(config),
  );
  const shown = {
    caption: rendered.caption,
    channelName: channel.name,
    mentionNames: rendered.mentionNames,
    now: rendered.now,
  };

  if (rendered.problem !== undefined) return { ...shown, v2: null };
  if (!config.noticeCounterButton) return { ...shown, v2: rendered.message.v2 };

  return {
    ...shown,
    v2: appendRow(rendered.message.v2, {
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
    }),
  };
}

export function quietNoticeBody(config: HoneypotConfig, path: string): string {
  return previewText(
    HONEYPOT_NOTICE_SURFACE,
    path,
    QUIET_NOTICE_BODY,
    NOTICE_SAMPLE,
    noticeWording(config),
  ).text;
}

export function dmOffersAppeal(config: HoneypotConfig): boolean {
  return config.action === 'ban' && (config.appealPanelId ?? '') !== '';
}

function dmWording(
  config: HoneypotConfig,
): Pick<HoneypotDmFacts, 'action' | 'appealUrl' | 'inviteUrl'> {
  const { action, appealUrl, inviteUrl } = dmPlaceholderFacts(config, {
    guildName: DM_SAMPLE.facts.guildName,
    appealUrl: dmOffersAppeal(config) ? SAMPLE_APPEAL_URL : undefined,
  });
  return { action, appealUrl, inviteUrl };
}

export function dmPreview(config: HoneypotConfig, tier: EntitlementTier): DmPreview {
  const wording = dmWording(config);
  const render = (from: EntitlementTier) =>
    previewMessage(HONEYPOT_DM_SURFACE, layoutFor(config, 'dmLayout', from), DM_SAMPLE, wording);

  const own = render(tier);
  const builtIn = own.problem !== undefined && tier !== 'free';
  const rendered = builtIn ? render('free') : own;
  const shown = {
    caption: rendered.caption,
    builtIn,
    mentionNames: rendered.mentionNames,
    now: rendered.now,
  };

  if (rendered.problem !== undefined) return { ...shown, v2: null };

  const extra: V2Component[] = [
    { kind: 'separator', divider: true, spacing: 'small' },
    { kind: 'text', content: RECOVERY_ADVICE },
  ];

  const buttons: MessageButton[] = [];

  if (wording.appealUrl) {
    buttons.push({ key: APPEAL_KEY, style: 'link', label: 'Appeal', url: wording.appealUrl });
  }

  if (wording.inviteUrl) {
    buttons.push({ key: INVITE_KEY, style: 'link', label: 'Rejoin', url: wording.inviteUrl });
  }

  if (buttons.length > 0) extra.push({ kind: 'row', row: { kind: 'buttons', buttons } });

  return {
    ...shown,
    v2: extra.reduce<V2Component[]>(
      (carried, component) => appendRow(carried, component),
      [...rendered.message.v2],
    ),
  };
}
