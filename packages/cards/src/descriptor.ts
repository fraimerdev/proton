import { z } from 'zod';
import { CARD_PRESETS } from './presets.ts';

/**
 * What a card is, as data.
 *
 * A discriminated union, which the v1 form generator explicitly refuses
 * (`packages/core/src/config/descriptor.ts`) — and correctly, but that rule
 * governs **module config**, the thing a guild admin edits in a generated form.
 * This is an internal render argument that no admin ever sees; the module-facing
 * surface stays inside the v1 vocabulary (see `@proton/module-welcome`'s config,
 * where the only card settings are a boolean and an enum).
 */

const displayName = z
  .string()
  .min(1)
  .max(64)
  .describe('The member’s display name, already resolved — cards never look one up.');

/**
 * An https URL; the *host* allowlist lives in the fetcher, not here.
 *
 * Deliberate split. The scheme is checked here because `z.url()` alone accepts
 * anything `new URL()` parses — `javascript:alert(1)` included — and a descriptor
 * that admits a non-https scheme is a footgun for any future caller that renders
 * a card without going through `HttpAvatarFetcher`. The *host* check stays in the
 * fetcher instead, because that is the one place the bytes actually leave the
 * process, so it cannot be routed around by constructing the object directly.
 */
const avatarUrl = z.url({ protocol: /^https$/ }).max(2048);

const cardBase = {
  preset: z.enum(CARD_PRESETS).default('midnight'),
  displayName,
  avatarUrl: avatarUrl.optional(),
};

export const rankCardSchema = z
  .object({
    kind: z.literal('rank'),
    ...cardBase,
    level: z.number().int().min(0).max(9999),
    /**
     * Leaderboard position, 1-based. Optional because computing it is a second
     * query the caller may reasonably decline to run — the card then simply omits
     * the `#n`, rather than printing a placeholder that reads like a real rank.
     */
    rank: z.number().int().min(1).optional(),
    /** Lifetime XP, shown verbatim. */
    totalXp: z.number().int().min(0),
    /**
     * Progress within the current level, as a numerator and denominator.
     *
     * The curve is not this package's business: `leveling` owns
     * `xpForLevel`/`level` and is exhaustively property-tested on them
     * (docs/PHASE-3.md §3.B). Passing the two resolved numbers instead of the raw
     * XP keeps exactly one implementation of the curve in the repo — a second one
     * here would drift and the card would disagree with `/rank`.
     */
    xpIntoLevel: z.number().int().min(0),
    xpForNextLevel: z.number().int().min(1),
  })
  .refine((card) => card.xpIntoLevel <= card.xpForNextLevel, {
    path: ['xpIntoLevel'],
    message:
      'progress into the level cannot exceed the level’s span — a bar wider than its track is a ' +
      'curve bug upstream, so it is refused here rather than clamped and hidden',
  });

/**
 * `welcome` and `goodbye` share a shape and differ only in copy (§3.C), so they
 * share a schema builder. Separate literals rather than one schema with a
 * `tone` field, because the discriminant is what makes the union exhaustive at
 * the layout switch.
 */
function greetingCard<K extends 'welcome' | 'goodbye'>(kind: K) {
  return z.object({
    kind: z.literal(kind),
    ...cardBase,
    guildName: z.string().min(1).max(100),
    /** Post-event count: after the join for `welcome`, after the leave for `goodbye`. */
    memberCount: z.number().int().min(0),
  });
}

export const welcomeCardSchema = greetingCard('welcome');
export const goodbyeCardSchema = greetingCard('goodbye');

export const cardDescriptorSchema = z.discriminatedUnion('kind', [
  rankCardSchema,
  welcomeCardSchema,
  goodbyeCardSchema,
]);

export type CardDescriptor = z.infer<typeof cardDescriptorSchema>;
export type CardDescriptorInput = z.input<typeof cardDescriptorSchema>;
export type RankCard = z.infer<typeof rankCardSchema>;
export type WelcomeCard = z.infer<typeof welcomeCardSchema>;
export type GoodbyeCard = z.infer<typeof goodbyeCardSchema>;

export type CardKind = CardDescriptor['kind'];

export interface CardSize {
  width: number;
  height: number;
}

/**
 * Fixed per kind, and exported so callers can assert them.
 *
 * Discord renders an attached image inline at up to 550px wide on desktop and
 * scales it down, so these are 2× that band — large enough to stay sharp on a
 * HiDPI client, small enough that the PNG stays well inside the 10 MiB per-file
 * limit the multipart path documents.
 */
export const CARD_SIZES: Record<CardKind, CardSize> = {
  rank: { width: 900, height: 240 },
  welcome: { width: 900, height: 320 },
  goodbye: { width: 900, height: 320 },
};

export function sizeFor(kind: CardKind): CardSize {
  return CARD_SIZES[kind];
}
