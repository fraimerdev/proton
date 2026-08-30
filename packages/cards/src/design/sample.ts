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
} as const;
