import type { ModuleContext } from '@proton/core';
import type { ModerationConfig } from '../config.ts';
import { MODULE_ID } from '../perform.ts';
import type { ExtraOutcome, ProofMessage } from './types.ts';

export function proofKey(root: string): string {
  return `${root}:proof`;
}

export async function deleteProof(
  ctx: ModuleContext<ModerationConfig>,
  input: { proof: Pick<ProofMessage, 'channelId' | 'messageId'>; root: string; actorId: string },
): Promise<{ deleted: boolean; outcome: ExtraOutcome }> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_message',
    actorId: input.actorId,
    idempotencyKey: proofKey(input.root),
    dryRun: false,
    record: false,
    payload: { channelId: input.proof.channelId, messageId: input.proof.messageId },
  });

  if (result.status === 'executed' || result.status === 'skipped_duplicate') {
    return {
      deleted: true,
      outcome: { step: 'delete_proof', status: 'done', message: 'Deleted the message.' },
    };
  }

  if (result.failure?.code === 'discord_404') {
    return {
      deleted: true,
      outcome: {
        step: 'delete_proof',
        status: 'skipped',
        message: 'The message was already gone.',
      },
    };
  }

  const reason = result.failure?.humanReason ?? 'Discord gave no reason.';
  ctx.logger.warn(`moderation could not delete a proof message: ${reason}`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    channelId: input.proof.channelId,
  });

  return {
    deleted: false,
    outcome: {
      step: 'delete_proof',
      status: 'failed',
      message: `Couldn't delete the message: ${reason}`,
    },
  };
}
