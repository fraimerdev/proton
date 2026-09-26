import type { SimulationAdapter, SimulationBuild, SimulationScene } from '@proton/core';
import { readChoice, readInteger } from '@proton/core';
import { isSilentLevelUp, type LevelingConfig } from './config.ts';
import { xpForLevel } from './curve.ts';
import { renderLevelUpTemplate } from './level-up.ts';
import { LEVEL_UP_SURFACE, type LevelUpPlaceholderFacts } from './placeholders.ts';

const NOTHING_TO_POST =
  'the message is empty, so a real level-up posts nothing. Write something before testing it.';

const ANNOUNCEMENTS_OFF =
  'level-up announcements are off, so a real level-up posts nothing. Turn on Announce level-ups ' +
  'before testing it.';

const SOURCES = ['message', 'voice', 'admin', 'reward'] as const;

function factsFor(scene: SimulationScene): LevelUpPlaceholderFacts {
  const previousLevel = readInteger(scene.inputs, 'previousLevel', 4);
  const level = Math.max(previousLevel + 1, readInteger(scene.inputs, 'level', 5));
  const source = readChoice(scene.inputs, 'source', SOURCES, 'message');
  const rank = readInteger(scene.inputs, 'rank', 12);

  return {
    userId: scene.subject.user.id,
    user: scene.subject.user,
    member: scene.subject.member,
    level,
    previousLevel,
    xp: xpForLevel(level),
    gained: source === 'admin' ? undefined : readInteger(scene.inputs, 'xpGained', 23),
    source,
    rank: { rank, messages: 812, voiceSeconds: 18_000 },
    rankedMemberCount: scene.server?.memberCount ?? null,
    // Empty rather than invented: the reward plan comes from what the executor was about to grant,
    // and a rehearsal grants nothing.
    rewards: { granted: [], revoked: [] },
    server: scene.server,
    ...(scene.originChannel === null ? {} : { originChannel: scene.originChannel }),
    destinationChannel: scene.destinationChannel ?? { id: '' },
    bot: scene.bot,
  };
}

export const LEVELING_LEVEL_UP_SIMULATION: SimulationAdapter<LevelingConfig> = {
  descriptor: {
    id: 'leveling.level_up',
    moduleId: 'leveling',
    label: 'Level-up announcement',
    summary: 'What Proton posts when a member reaches a new level.',
    surfaceId: LEVEL_UP_SURFACE.id,
    configPath: 'levelUpMessage',
    output: 'message',
    delivery: 'channel',
    channelPath: 'levelUpChannelId',
    subject: true,
    inputs: [
      {
        key: 'previousLevel',
        label: 'Level before',
        kind: 'integer',
        min: 0,
        max: 999,
        fallback: 4,
      },
      { key: 'level', label: 'Level reached', kind: 'integer', min: 1, max: 1000, fallback: 5 },
      {
        key: 'source',
        label: 'How they levelled',
        kind: 'choice',
        options: [
          { value: 'message', label: 'By chatting' },
          { value: 'voice', label: 'In voice' },
          { value: 'admin', label: 'XP given by staff' },
          { value: 'reward', label: 'XP from a reward' },
        ],
        fallback: 'message',
      },
      { key: 'xpGained', label: 'XP gained', kind: 'integer', min: 0, max: 100_000, fallback: 23 },
      {
        key: 'rank',
        label: 'Rank on the leaderboard',
        kind: 'integer',
        min: 1,
        max: 100_000,
        fallback: 12,
      },
    ],
    note:
      'A test gives no XP, levels or reward roles, so the reward and removed role placeholders ' +
      'come out empty. With no level-up channel set, a real level-up posts in the channel the ' +
      'member was chatting in.',
  },

  destination: (config) => config.levelUpChannelId ?? null,

  build(config, scene): SimulationBuild {
    const message = config.levelUpMessage;

    if (!config.levelUpAnnounce) {
      return { ok: false, humanReason: ANNOUNCEMENTS_OFF, diagnostics: [] };
    }

    if (isSilentLevelUp(message)) {
      return { ok: false, humanReason: NOTHING_TO_POST, diagnostics: [] };
    }

    const rendered = renderLevelUpTemplate(message, factsFor(scene), scene.now);

    if (!rendered.ok) {
      return { ok: false, humanReason: rendered.humanReason, diagnostics: rendered.diagnostics };
    }

    return {
      ok: true,
      caption: `${scene.subject.displayName} reaching level ${readInteger(scene.inputs, 'level', 5)}`,
      diagnostics: rendered.diagnostics,
      // No rank card: only /rank attaches one, so a level-up rehearsal must not invent it.
      output: { kind: 'message', message: rendered.message, attachments: [] },
    };
  },
};

export const levelingSimulations: SimulationAdapter<LevelingConfig>[] = [
  LEVELING_LEVEL_UP_SIMULATION,
];
