import type { ActionKind, ActionResult, ModuleContext } from '@proton/core';
import type { AutomodConfig } from './config.ts';
import { MODULE_ID } from './deps.ts';
import { diffNativeRules, type NativeOp, parseNativeRules, planNativeRules } from './native.ts';

export interface SyncInput {
  ctx: ModuleContext<AutomodConfig>;
  botUserId: string;
  readNativeRules(guildId: string): Promise<unknown>;
  reason?: string;
  // The module-level switch, which the config schema knows nothing about. False means take
  // everything down rather than reconcile toward it.
  active?: boolean;
}

export interface SyncOutcome {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  foreign: string[];
  failures: string[];
}

const KIND_OF: Record<NativeOp['op'], ActionKind> = {
  create: 'automod_rule_create',
  update: 'automod_rule_update',
  delete: 'automod_rule_delete',
};

function payloadOf(op: NativeOp): Record<string, unknown> {
  if (op.op === 'delete') return { ruleId: op.ruleId };

  const { name, eventType, triggerMetadata, actions, enabled, exemptRoles, exemptChannels } =
    op.rule;
  const base = { name, eventType, triggerMetadata, actions, enabled, exemptRoles, exemptChannels };

  return op.op === 'create'
    ? { ...base, triggerType: op.rule.triggerType }
    : { ...base, ruleId: op.ruleId };
}

function labelOf(op: NativeOp): string {
  return op.op === 'delete' ? op.name : op.rule.name;
}

// Digested over what the call will send, not over the rule's identity: two consecutive edits to
// the same rule are two different requests, and a key naming only the rule would make the second
// one look like a redelivery of the first and drop it.
function keyFor(guildId: string, op: NativeOp): string {
  const digest = Bun.hash(JSON.stringify(payloadOf(op))).toString(36);
  return `${MODULE_ID}:native:${guildId}:${op.op}:${labelOf(op)}:${digest}`;
}

function failureOf(op: NativeOp, result: ActionResult): string | null {
  if (result.status !== 'failed_precheck' && result.status !== 'failed_api') return null;
  return `could not ${op.op} the Discord AutoMod rule '${labelOf(op)}': ${
    result.failure?.humanReason ?? 'no reason was reported'
  }`;
}

/**
 * Stateless reconcile: list, diff, apply. Nothing is stored on Proton's side, so a rule an admin
 * deletes in Discord's UI comes back on the next sync and there is no local row to drift.
 */
export async function syncNativeRules(input: SyncInput): Promise<SyncOutcome> {
  const { ctx } = input;
  const outcome: SyncOutcome = {
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    foreign: [],
    failures: [],
  };

  let raw: unknown;
  try {
    raw = await input.readNativeRules(ctx.guildId);
  } catch (error) {
    outcome.failures.push(
      'could not read this server’s Discord AutoMod rules, so none of them were changed. Proton ' +
        'needs the Manage Server permission to see them. ' +
        (error instanceof Error ? error.message : String(error)),
    );
    return outcome;
  }

  const plan = planNativeRules(
    input.active === false ? { ...ctx.config, enabled: false } : ctx.config,
  );
  const diff = diffNativeRules(plan.desired, parseNativeRules(raw), input.botUserId);

  outcome.unchanged = diff.unchanged.length;
  outcome.foreign = diff.foreign;

  for (const op of diff.ops) {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: KIND_OF[op.op],
      actorId: MODULE_ID,
      reason: input.reason ?? 'Proton automod configuration',
      idempotencyKey: keyFor(ctx.guildId, op),
      dryRun: false,
      // Configuration, not moderation. A case row per rule edit would bury the ledger.
      record: false,
      payload: payloadOf(op),
    });

    const failure = failureOf(op, result);
    if (failure) {
      outcome.failures.push(failure);
      continue;
    }

    if (op.op === 'create') outcome.created += 1;
    else if (op.op === 'update') outcome.updated += 1;
    else outcome.deleted += 1;
  }

  return outcome;
}
