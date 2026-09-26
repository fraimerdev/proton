import type { ModuleContext, ResolvedAttachment } from '@proton/core';
import { describeError } from '@proton/db';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import type { CaseAttachment, NewCaseMessage } from './store.ts';
import type { ExtraOutcome, ProofMessage } from './types.ts';

export const CASE_MESSAGE_RETENTION_MS = 30 * 86_400_000;

export function caseAttachmentOf(attachment: ResolvedAttachment): CaseAttachment {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    url: attachment.url,
    expiresAt: attachment.expiresAt,
  };
}

export async function snapshotCaseHistory(
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
  input: { caseId: string; targetId: string; proof?: ProofMessage | undefined; now: number },
): Promise<ExtraOutcome | null> {
  const withHistory = ctx.config.punish.messageHistory;
  const proof = input.proof;
  if (!withHistory && !proof) return null;

  const { history, caseMessages } = deps;
  if (!caseMessages || (withHistory && !history)) {
    return {
      step: 'history',
      status: 'failed',
      message: withHistory
        ? "Couldn't save their recent messages to the case."
        : "Couldn't keep the message on the case.",
    };
  }

  const expiresAt = input.now + CASE_MESSAGE_RETENTION_MS;
  const base = { caseId: input.caseId, guildId: ctx.guildId, expiresAt };

  try {
    const buffered =
      withHistory && history ? await history.recent(ctx.guildId, input.targetId, input.now) : [];

    const rows: NewCaseMessage[] = [
      ...(proof
        ? [
            {
              ...base,
              messageId: proof.messageId,
              channelId: proof.channelId,
              authorId: proof.authorId,
              content: proof.content,
              attachments: proof.attachments.map(caseAttachmentOf),
              createdAt: proof.createdAt ?? input.now,
              deletedAt: null,
              proof: true,
            },
          ]
        : []),
      ...buffered
        .filter((message) => message.messageId !== proof?.messageId)
        .map((message) => ({ ...base, ...message, proof: false })),
    ];

    if (rows.length === 0) {
      return {
        step: 'history',
        status: 'skipped',
        message: 'They had no recent messages to save.',
      };
    }

    await caseMessages.save(rows);

    return {
      step: 'history',
      status: 'done',
      message: withHistory
        ? `Saved ${rows.length} recent message${rows.length === 1 ? '' : 's'} to the case.`
        : 'Kept the message on the case.',
    };
  } catch (error) {
    ctx.logger.warn(
      `moderation could not snapshot messages onto case ${input.caseId}: ${describeError(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, caseId: input.caseId },
    );

    return {
      step: 'history',
      status: 'failed',
      message: withHistory
        ? "Couldn't save their recent messages to the case."
        : "Couldn't keep the message on the case.",
    };
  }
}
