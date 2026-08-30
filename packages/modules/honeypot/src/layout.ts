import type { V2Component } from '@proton/core';
import { interactiveKeys } from '@proton/core';
import type { z } from 'zod';

export const HONEYPOT_POT = '🍯';

// DESIGN.md's Blocked Coral. Kept here rather than imported from config.ts, which imports this.
export const HONEYPOT_ACCENT = 0xff7a86;

export const COUNTER_KEY = 'honeypot-counter';
export const APPEAL_KEY = 'honeypot-appeal';
export const INVITE_KEY = 'honeypot-invite';

const ONLY_LINK_BUTTONS =
  'a honeypot layout can carry link buttons and nothing else. Proton watches for presses on the ' +
  'buttons it adds itself — the counter, the appeal and the way back in — and it has no handler ' +
  'for one you place, so it would do nothing when a member pressed it.';

export function refineHoneypotLayout(
  message: { components: unknown[]; v2?: V2Component[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if (interactiveKeys({ components: [], v2: message.v2 ?? [] }).length > 0) {
    ctx.addIssue({ code: 'custom', path: ['v2'], message: ONLY_LINK_BUTTONS });
  }
}

export const NOTICE_HEADING = `## ${HONEYPOT_POT}  DO NOT SEND MESSAGES IN THIS CHANNEL`;

export const NOTICE_BODY =
  'This channel is used to catch spam bots and compromised accounts, which post in every ' +
  'channel they can see. Any message sent here means **{consequence}**.{purge}\n\n' +
  'There is never a reason to post here.';

// What the notice says when an admin would rather not advertise that the channel is a trap. Same
// warning, no mechanism.
export const QUIET_NOTICE_BODY =
  'Nobody has any reason to post in this channel. Anything sent here means **{consequence}**.' +
  '{purge}\n\nThere is never a reason to post here.';

export const DEFAULT_NOTICE_LAYOUT = {
  mentions: { everyone: false, roles: false, users: false },
  v2: [
    {
      kind: 'container' as const,
      accentColor: HONEYPOT_ACCENT,
      children: [
        { kind: 'text' as const, content: NOTICE_HEADING },
        { kind: 'text' as const, content: NOTICE_BODY },
      ],
    },
  ],
};

export const DM_HEADING = '## Honeypot triggered';

export const DM_BODY =
  'A message was sent from your account in **{server}**, in a channel that exists only to catch ' +
  'spam bots. You were **{action}** as a result.\n\nIf you did not send it, your account is very ' +
  'likely compromised. Somebody holding your session token can post as you without ever knowing ' +
  'your password.';

export const RECOVERY_ADVICE =
  '**What to do now**\nChange your password, log out of every other session, and check which ' +
  'apps you have authorised in Discord’s settings.\n\n' +
  'This message was sent by a bot, and nobody reads replies to it.';

export const DEFAULT_DM_LAYOUT = {
  mentions: { everyone: false, roles: false, users: false },
  v2: [
    {
      kind: 'container' as const,
      accentColor: HONEYPOT_ACCENT,
      children: [
        { kind: 'text' as const, content: DM_HEADING },
        { kind: 'text' as const, content: DM_BODY },
      ],
    },
  ],
};
