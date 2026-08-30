import { type AppealLinkClaims, readAppealLink } from '@proton/core';
import type { AppealView } from '@proton/module-appeals/web';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { ApiClient } from '../lib/api-client.ts';
import { getDiscordUserId } from '../lib/discord-token.ts';
import { loadEnv } from '../lib/env.ts';
import { requireSession } from '../middleware/guild-access.ts';

const env = loadEnv();
const api = new ApiClient(env.API_URL, env.API_SHARED_SECRET);

// Expired, forged, malformed and signed-for-another-deployment all read the same to whoever holds
// the link. Which one it is goes to the server log; telling the browser would help nobody but a
// forger narrowing down a signature.
const STALE =
  'This appeal link is no longer valid. If a moderator sent you a newer one, open that instead.';

const NOT_YOURS =
  'This appeal link was issued to a different Discord account. Sign out, sign back in with the ' +
  'account the link was sent to, and open it again.';

export type AppealOutcome =
  | { ok: true; guildId: string; view: AppealView }
  | { ok: false; reason: string };

export type SubmitOutcome = { ok: true; number: number } | { ok: false; reason: string };

async function claimsFor(
  token: string,
  sessionUserId: string,
): Promise<{ claims: AppealLinkClaims } | { reason: string }> {
  const secret = env.VERIFY_LINK_SECRET;
  if (!secret) {
    console.error(
      'somebody opened an appeal link but VERIFY_LINK_SECRET is not set for the dashboard, so no ' +
        'link can ever be honoured. Set it to the same value the worker has.',
    );
    return { reason: STALE };
  }

  const read = await readAppealLink(token, secret);
  if ('invalid' in read) {
    console.warn(`an appeal link was refused: ${read.invalid}`);
    return { reason: STALE };
  }

  // The link proves which account it was minted for, and the session proves who is holding it.
  // Without this a link forwarded to somebody else would let them appeal on the owner's behalf.
  const discordUserId = await getDiscordUserId(sessionUserId);
  if (discordUserId !== read.claims.userId) return { reason: NOT_YOURS };

  return { claims: read.claims };
}

export const openAppeal = createServerFn({ method: 'POST' })
  .middleware([requireSession])
  .validator(z.object({ token: z.string().min(1).max(1024) }))
  .handler(async ({ data, context }): Promise<AppealOutcome> => {
    const read = await claimsFor(data.token, context.session.user.id);
    if ('reason' in read) return { ok: false, reason: read.reason };

    try {
      const { view, guildId } = await api.getAppealForm(read.claims);
      return { ok: true, guildId, view: view as AppealView };
    } catch (error) {
      console.error(
        `an appeal form could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, reason: 'Proton could not reach this server. Try again in a moment.' };
    }
  });

export const submitAppeal = createServerFn({ method: 'POST' })
  .middleware([requireSession])
  .validator(
    z.object({
      token: z.string().min(1).max(1024),
      answers: z.record(z.string(), z.string().max(4000)),
    }),
  )
  .handler(async ({ data, context }): Promise<SubmitOutcome> => {
    // Re-read from the token, never from a hidden field: what the browser sends about who it is
    // and what it is appealing carries no weight at all.
    const read = await claimsFor(data.token, context.session.user.id);
    if ('reason' in read) return { ok: false, reason: read.reason };

    try {
      const { number } = await api.submitAppeal(read.claims, data.answers);
      return { ok: true, number };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      console.warn(`an appeal was refused: ${reason}`);
      return { ok: false, reason: 'Your appeal was not sent. ' + reason };
    }
  });
