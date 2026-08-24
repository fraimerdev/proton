import { readVerifyLink } from '@proton/core';
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
  'This verification link is no longer valid. Head back to the server and press Verify again to ' +
  'get a fresh one.';

const NOT_YOURS =
  'This verification link was issued to a different Discord account. Sign out, sign back in with ' +
  'the account you are verifying, and open the link again.';

export type VerificationOutcome = { ok: true; guildId: string } | { ok: false; reason: string };

export const completeWebVerification = createServerFn({ method: 'POST' })
  .middleware([requireSession])
  .validator(z.object({ token: z.string().min(1).max(1024) }))
  .handler(async ({ data, context }): Promise<VerificationOutcome> => {
    const secret = env.VERIFY_LINK_SECRET;
    if (!secret) {
      console.error(
        'a member opened a verification link but VERIFY_LINK_SECRET is not set for the ' +
          'dashboard, so no link can ever be honoured. Set it to the same value the worker has.',
      );
      return { ok: false, reason: STALE };
    }

    const read = await readVerifyLink(data.token, secret);
    if ('invalid' in read) {
      console.warn(`a verification link was refused: ${read.invalid}`);
      return { ok: false, reason: STALE };
    }

    const { guildId, userId, jti } = read.claims;

    // The whole point of this mode: the link proves which account it was minted for, and the
    // session proves who is holding it. Skipping this would let a stolen link verify anybody.
    const discordUserId = await getDiscordUserId(context.session.user.id);
    if (discordUserId !== userId) return { ok: false, reason: NOT_YOURS };

    try {
      await api.recordVerificationPass(guildId, { userId, jti });
    } catch (error) {
      console.error(
        `${userId} passed verification on the website but Proton could not be told: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        ok: false,
        reason:
          'You are verified, but Proton could not reach the server to hand out your role. Try ' +
          'the link again in a moment, or tell a moderator.',
      };
    }

    return { ok: true, guildId };
  });
