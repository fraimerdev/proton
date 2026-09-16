import type { SimulationAdapter, SimulationBuild, SimulationScene } from '@proton/core';
import { readInteger } from '@proton/core';
import type { HoneypotConfig } from './config.ts';
import { buildNoticeMessage } from './notice.ts';
import { buildDirectMessage } from './render.ts';

const NOTICE_OFF =
  'the warning message is switched off, so Proton posts nothing in a bait channel. Switch ' +
  '“Post the warning” on before testing it.';

const DM_OFF =
  'the direct message is switched off, so a caught member is never told why. Switch “Send a ' +
  'direct message” on before testing it.';

const NO_BAIT =
  'this trap has no bait channel yet, so there is nowhere the warning would go. Add one first.';

function channelIdFor(config: HoneypotConfig, scene: SimulationScene): string | null {
  const index = readInteger(scene.inputs, 'channelIndex', 0);

  return (
    scene.destinationChannel?.id ??
    config.channels[index]?.channelId ??
    config.channels[0]?.channelId ??
    null
  );
}

export const HONEYPOT_NOTICE_SIMULATION: SimulationAdapter<HoneypotConfig> = {
  descriptor: {
    id: 'honeypot.notice',
    moduleId: 'honeypot',
    label: 'Warning message',
    summary: 'The message Proton keeps pinned at the top of a bait channel.',
    surfaceId: 'honeypot.notice',
    configPath: 'noticeLayout',
    output: 'message',
    delivery: 'channel',
    subject: false,
    inputs: [
      {
        key: 'caught',
        label: 'Members caught so far',
        kind: 'integer',
        min: 0,
        max: 100_000,
        fallback: 3,
      },
      {
        key: 'channelIndex',
        label: 'Bait channel',
        kind: 'integer',
        min: 0,
        max: 999,
        fallback: 0,
        fixed: true,
      },
    ],
    note:
      'The real warning is edited in place in the bait channel, never posted twice. This test ' +
      'posts a copy wherever you choose, and the counter button on it does nothing.',
  },

  destination: (config) => config.channels[0]?.channelId ?? null,

  build(config, scene): SimulationBuild {
    if (!config.postNotice) return { ok: false, humanReason: NOTICE_OFF, diagnostics: [] };

    const channelId = channelIdFor(config, scene);
    if (channelId === null) return { ok: false, humanReason: NO_BAIT, diagnostics: [] };

    const built = buildNoticeMessage(
      config,
      channelId,
      readInteger(scene.inputs, 'caught', 3),
      scene.tier,
      {
        guildId: scene.guildId,
        server: scene.server,
        bot: scene.bot,
        ...(scene.destinationChannel === null ? {} : { channel: scene.destinationChannel }),
        now: scene.now,
      },
    );

    if (!built.ok) return { ok: false, humanReason: built.humanReason, diagnostics: [] };

    return {
      ok: true,
      caption: `a trap in ${scene.server?.name ?? 'this server'} that has caught ${readInteger(scene.inputs, 'caught', 3)}`,
      diagnostics: [],
      output: { kind: 'message', message: built.message, attachments: [] },
    };
  },
};

export const HONEYPOT_DM_SIMULATION: SimulationAdapter<HoneypotConfig> = {
  descriptor: {
    id: 'honeypot.dm',
    moduleId: 'honeypot',
    label: 'Direct message',
    summary: 'What a member gets told after the trap catches them.',
    surfaceId: 'honeypot.dm',
    configPath: 'dmLayout',
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [],
    note:
      'Sent to you, never to the example member — nobody is caught, banned or blocked by this. The ' +
      'Appeal button is left out unless this trap bans and has an appeal form, because the real ' +
      'link is minted for a real catch.',
  },

  build(config, scene): SimulationBuild {
    if (!config.sendDirectMessage) return { ok: false, humanReason: DM_OFF, diagnostics: [] };

    const built = buildDirectMessage(
      config,
      scene.tier,
      {
        guildName: scene.server?.name ?? 'this server',
        server: scene.server,
        user: scene.subject.user,
        bot: scene.bot,
        // No appeal url: the real one is signed for a real catch, and a link that opens somebody
        // else's appeal form is not something a rehearsal may mint. The Rejoin link comes from
        // config inside dmPlaceholderFacts, exactly as it does on a real catch.
      },
      scene.now,
    );

    if (!built.ok) return { ok: false, humanReason: built.humanReason, diagnostics: [] };

    return {
      ok: true,
      caption: `${scene.subject.displayName} caught in ${scene.server?.name ?? 'this server'}`,
      diagnostics: [],
      output: { kind: 'message', message: built.message, attachments: [] },
    };
  },
};

export const honeypotSimulations: SimulationAdapter<HoneypotConfig>[] = [
  HONEYPOT_NOTICE_SIMULATION,
  HONEYPOT_DM_SIMULATION,
];
