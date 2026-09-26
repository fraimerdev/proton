import type { CardBadge } from '../descriptor.ts';
import { toHexColour } from '../presets.ts';
import { TIER_COLOURS } from './badges.ts';

const PREVIEW_BADGES: CardBadge[] = [
  { shape: 'circle', colour: toHexColour(TIER_COLOURS.gold), icon: 'chat' },
  { shape: 'shield', colour: toHexColour(TIER_COLOURS.silver), icon: 'microphone' },
  { shape: 'hexagon', colour: toHexColour(TIER_COLOURS.bronze), icon: 'star' },
  { shape: 'square', colour: toHexColour(TIER_COLOURS.single), icon: 'rocket' },
];

// Sample data, not the viewer's real standing: a preview is a picture of the settings, and asking
// the leaderboard for a number they may not have yet would make it a picture of nothing. Shared so
// the dashboard's live card and the api's confirmation render show the same figures.
export const PREVIEW_SAMPLE = {
  level: 12,
  rank: 3,
  totalXp: 48_210,
  xpIntoLevel: 1_240,
  xpForNextLevel: 2_000,
  guildName: 'Your server',
  memberCount: 1_204,
  badges: PREVIEW_BADGES,
  achievementCount: 7,
} as const;
