import {
  type BotNameStyle,
  NAME_STYLE_OUTCOMES,
  NAME_STYLE_REASONS,
  type NameStyleReason,
  type NameStyleState,
} from '@proton/core';
import { z } from 'zod';
import {
  type DisplayNameStyle,
  displayNameStyleSchema,
  isSendableNameStyle,
  NAME_STYLE_EFFECT_CATALOGUE,
  NAME_STYLE_EFFECTS,
  NAME_STYLE_FONT_CATALOGUE,
  NAME_STYLE_FONTS,
  sameWireStyle,
  toWireStyle,
} from './name-style.ts';

export const NAME_STYLE_STATUS_STATES = [
  'none',
  'off',
  'unavailable',
  'applying',
  'applied',
  'ignored',
  'rejected',
  'unverified',
] as const;

export type NameStyleStatusState = (typeof NAME_STYLE_STATUS_STATES)[number];

export const nameStyleViewSchema = z.object({
  fontId: z.number().int(),
  effectId: z.number().int(),
  colours: z.array(z.number().int()),
  font: z.enum(NAME_STYLE_FONTS).nullable(),
  effect: z.enum(NAME_STYLE_EFFECTS).nullable(),
});

export type NameStyleView = z.infer<typeof nameStyleViewSchema>;

function slugFor<K extends string>(
  catalogue: Readonly<Record<K, { id: number }>>,
  id: number,
): K | null {
  const entries = Object.entries(catalogue) as [K, { id: number }][];
  return entries.find(([, entry]) => entry.id === id)?.[0] ?? null;
}

export function fromWireStyle(style: BotNameStyle | null): NameStyleView | null {
  if (style === null) return null;

  return {
    fontId: style.fontId,
    effectId: style.effectId,
    colours: [...style.colours],
    font: slugFor(NAME_STYLE_FONT_CATALOGUE, style.fontId),
    effect: slugFor(NAME_STYLE_EFFECT_CATALOGUE, style.effectId),
  };
}

const lastAttemptSchema = z.object({
  style: nameStyleViewSchema.nullable(),
  outcome: z.enum(NAME_STYLE_OUTCOMES),
  reason: z.enum(NAME_STYLE_REASONS).nullable(),
  attemptedAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
});

const confirmedStyleSchema = z.object({
  style: nameStyleViewSchema.nullable(),
  confirmedAt: z.number().int(),
});

export const nameStyleStatusSchema = z.object({
  state: z.enum(NAME_STYLE_STATUS_STATES),
  reason: z.enum(NAME_STYLE_REASONS).nullable(),
  requested: displayNameStyleSchema.nullable(),
  lastAttempt: lastAttemptSchema.nullable(),
  confirmed: confirmedStyleSchema.nullable(),
});

export type NameStyleStatus = z.infer<typeof nameStyleStatusSchema>;

interface StatusInput {
  enabled: boolean;
  requested: DisplayNameStyle | null;
  state: NameStyleState | null;
}

interface Headline {
  state: NameStyleStatusState;
  reason: NameStyleReason | null;
}

function headline({ enabled, requested, state }: StatusInput): Headline {
  if (!isSendableNameStyle(requested)) return { state: 'unavailable', reason: null };
  if (!enabled) return { state: 'off', reason: null };

  const wanted = toWireStyle(requested);
  if (wanted === null && state === null) return { state: 'none', reason: null };

  if (state === null || !sameWireStyle(state.requested, wanted)) {
    return { state: 'applying', reason: null };
  }

  if (state.outcome === 'confirmed') {
    return { state: state.confirmedAt === null ? 'unverified' : 'applied', reason: state.reason };
  }

  return { state: state.outcome, reason: state.reason };
}

function lastAttemptOf(state: NameStyleState | null): NameStyleStatus['lastAttempt'] {
  if (state === null) return null;

  return {
    style: fromWireStyle(state.requested),
    outcome: state.outcome,
    reason: state.reason,
    attemptedAt: state.attemptedAt,
    updatedAt: state.updatedAt,
  };
}

function confirmedOf(state: NameStyleState | null): NameStyleStatus['confirmed'] {
  if (state === null || state.confirmedAt === null) return null;
  return { style: fromWireStyle(state.confirmed), confirmedAt: state.confirmedAt };
}

export function describeNameStyleStatus(input: StatusInput): NameStyleStatus {
  return {
    ...headline(input),
    requested: input.requested,
    lastAttempt: lastAttemptOf(input.state),
    confirmed: confirmedOf(input.state),
  };
}
