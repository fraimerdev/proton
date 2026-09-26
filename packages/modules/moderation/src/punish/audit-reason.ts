import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import {
  type AuditedDirection,
  auditReasonKeys,
  renderAuditReasonTemplate,
} from '../placeholders.ts';
import { AUDITED_DIRECTIONS, type PunishDirection } from './config.ts';
import type { PunishActor } from './types.ts';

export interface AuditReasonInput {
  actor: PunishActor;
  reason: string;
  durationMs: number | null;
}

export function isAudited(direction: PunishDirection): direction is AuditedDirection {
  return (AUDITED_DIRECTIONS as readonly PunishDirection[]).includes(direction);
}

async function moderatorName(
  deps: ModerationDeps,
  actor: PunishActor,
  wanted: boolean,
): Promise<string | null> {
  if (actor.kind === 'automation') return actor.label ?? null;
  if (!wanted || !deps.placeholders) return actor.label ?? null;

  try {
    const profile = await deps.placeholders.user(actor.id);
    return profile?.username ?? actor.label ?? null;
  } catch {
    return actor.label ?? null;
  }
}

export function renderAuditReason(
  config: ModerationConfig,
  direction: AuditedDirection,
  facts: {
    moderatorId: string;
    moderatorName: string | null;
    reason: string;
    durationMs: number | null;
  },
  now: number,
): string {
  return renderAuditReasonTemplate(
    config.punish.types[direction].auditReason,
    {
      moderatorId: facts.moderatorId,
      moderatorName: facts.moderatorName,
      reason: facts.reason === '' ? null : facts.reason,
      durationMs: facts.durationMs,
    },
    now,
  );
}

export async function auditReasonFor(
  config: ModerationConfig,
  deps: ModerationDeps,
  direction: PunishDirection,
  input: AuditReasonInput,
  now: number,
): Promise<string | undefined> {
  if (!isAudited(direction)) return undefined;

  const template = config.punish.types[direction].auditReason;
  const name = await moderatorName(
    deps,
    input.actor,
    auditReasonKeys(template).has('moderator.username'),
  );

  const rendered = renderAuditReason(
    config,
    direction,
    {
      moderatorId: input.actor.id,
      moderatorName: name,
      reason: input.reason,
      durationMs: input.durationMs,
    },
    now,
  );

  return rendered === '' ? undefined : rendered;
}
