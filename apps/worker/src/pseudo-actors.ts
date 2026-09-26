import { ACHIEVEMENTS_ACTOR } from '@proton/module-achievements';
import { APPLICATIONS_ACTOR } from '@proton/module-applications';
import { PUNISH_ACTOR, REPORTS_ACTOR } from '@proton/module-moderation';
import { SERVERLOG_ACTOR } from '@proton/module-serverlog';

const PROTON = { username: 'Proton', avatarUrl: null };

export const PSEUDO_ACTORS: Record<string, { username: string; avatarUrl: string | null }> = {
  [SERVERLOG_ACTOR]: PROTON,
  [PUNISH_ACTOR]: PROTON,
  [REPORTS_ACTOR]: PROTON,
  [APPLICATIONS_ACTOR]: PROTON,
  [ACHIEVEMENTS_ACTOR]: { username: 'Achievements', avatarUrl: null },
};
