import type { SimulationAdapter, SimulationBuild, SimulationScene } from '@proton/core';
import { readInteger } from '@proton/core';
import type { HoneypotConfig } from './config.ts';
import { buildNoticeMessage } from './notice.ts';
import { buildDirectMessage } from './render.ts';

const NOTICE_OFF = 'the warning message is off. Turn on “Post a warning message” to test it.';

const DM_OFF = 'the DM is off. Turn on “Send a DM” to test it.';

const NO_BAIT = 'there’s no bait channel for the warning to go in yet. Add one first.';

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
    summary: 'The message Proton posts in each bait channel.',
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
    note: 'This posts a copy wherever you choose. The counter button on the copy does nothing.',
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
    summary: 'What a caught member is told, just before Proton acts.',
    surfaceId: 'honeypot.dm',
    configPath: 'dmLayout',
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [],
    note:
      'Sent to you, and nobody is caught, banned or blocked. The Appeal button is always left ' +
      'out, because each real appeal link is made for one catch.',
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
