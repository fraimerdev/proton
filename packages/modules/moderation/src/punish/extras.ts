import type { ActionExecutor, ActionKind, ActionResult, ModuleContext } from '@proton/core';
import type { ModerationConfig } from '../config.ts';
import { MODULE_ID } from '../perform.ts';
import type { ExtraOutcome, ExtraStep } from './types.ts';

type Ctx = ModuleContext<ModerationConfig>;

export const NOT_IN_VOICE_CODE = 40032;

export interface PunishActions {
  addRoleIds: readonly string[];
  removeRoleIds: readonly string[];
  disconnectVoice?: boolean;
}

export interface ExtrasInput {
  targetId: string;
  actorId: string;
  root: string;
  reason?: string;
  actions: PunishActions;
  executor?: ActionExecutor;
}

interface Planned {
  step: ExtraStep;
  kind: ActionKind;
  roleId?: string;
  payload: Record<string, unknown>;
  record: boolean;
}

export function extraKey(root: string, index: number): string {
  return `${root}:extra:${index}`;
}

function plan(targetId: string, actions: PunishActions): Planned[] {
  return [
    ...actions.addRoleIds.map(
      (roleId): Planned => ({
        step: 'add_role',
        kind: 'add_role',
        roleId,
        payload: { userId: targetId, roleId },
        record: true,
      }),
    ),
    ...actions.removeRoleIds.map(
      (roleId): Planned => ({
        step: 'remove_role',
        kind: 'remove_role',
        roleId,
        payload: { userId: targetId, roleId },
        record: true,
      }),
    ),
    ...(actions.disconnectVoice
      ? [
          {
            step: 'disconnect',
            kind: 'move_member',
            payload: { userId: targetId, channelId: null },
            record: false,
          } satisfies Planned,
        ]
      : []),
  ];
}

const DONE: Record<ExtraStep, (roleId?: string) => string> = {
  add_role: (roleId) => `Added <@&${roleId}>.`,
  remove_role: (roleId) => `Removed <@&${roleId}>.`,
  disconnect: () => 'Disconnected them from voice.',
  delete_proof: () => 'Deleted the message.',
  history: () => 'Saved their recent messages to the case.',
};

const FAILED: Record<ExtraStep, (roleId?: string) => string> = {
  add_role: (roleId) => `Couldn't add <@&${roleId}>`,
  remove_role: (roleId) => `Couldn't remove <@&${roleId}>`,
  disconnect: () => "Couldn't disconnect them from voice",
  delete_proof: () => "Couldn't delete the message",
  history: () => "Couldn't save their recent messages",
};

function outcomeOf(planned: Planned, result: ActionResult): ExtraOutcome {
  const base = { step: planned.step, ...(planned.roleId ? { roleId: planned.roleId } : {}) };

  if (result.status === 'executed' || result.status === 'skipped_duplicate') {
    return { ...base, status: 'done', message: DONE[planned.step](planned.roleId) };
  }

  if (planned.step === 'disconnect' && result.failure?.discordCode === NOT_IN_VOICE_CODE) {
    return { ...base, status: 'skipped', message: 'Not in voice, so nothing to do.' };
  }

  return {
    ...base,
    status: 'failed',
    message: `${FAILED[planned.step](planned.roleId)}: ${
      result.failure?.humanReason ?? 'Discord gave no reason.'
    }`,
  };
}

export async function runExtras(ctx: Ctx, input: ExtrasInput): Promise<ExtraOutcome[]> {
  const executor = input.executor ?? ctx.executor;
  const outcomes: ExtraOutcome[] = [];

  for (const [index, planned] of plan(input.targetId, input.actions).entries()) {
    const result = await executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: planned.kind,
      actorId: input.actorId,
      targetId: input.targetId,
      ...(input.reason ? { reason: input.reason } : {}),
      idempotencyKey: extraKey(input.root, index),
      dryRun: false,
      ...(planned.record ? {} : { record: false }),
      payload: planned.payload,
    });

    const outcome = outcomeOf(planned, result);
    if (outcome.status === 'failed') {
      ctx.logger.warn(`moderation extra ${planned.step} failed: ${outcome.message}`, {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        userId: input.targetId,
      });
    }
    outcomes.push(outcome);
  }

  return outcomes;
}

export function runPunishExtras(ctx: Ctx, input: ExtrasInput): Promise<ExtraOutcome[]> {
  return runExtras(ctx, input);
}

export function runLiftExtras(
  ctx: Ctx,
  input: Omit<ExtrasInput, 'actions'> & {
    actions: { addRoleIds: readonly string[]; removeRoleIds: readonly string[] };
  },
): Promise<ExtraOutcome[]> {
  return runExtras(ctx, {
    ...input,
    actions: { addRoleIds: input.actions.addRoleIds, removeRoleIds: input.actions.removeRoleIds },
  });
}
