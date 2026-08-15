import type { z } from 'zod';
import type { ActionKind } from './kinds.ts';
import {
  type Attachment,
  addReactionPayloadSchema,
  banPayloadSchema,
  deleteMessagePayloadSchema,
  editMessagePayloadSchema,
  interactionFollowupPayloadSchema,
  interactionReplyPayloadSchema,
  isDeferral,
  kickPayloadSchema,
  lockdownPayloadSchema,
  MAX_TIMEOUT_MS,
  MESSAGE_FLAG_EPHEMERAL,
  purgePayloadSchema,
  roleChangePayloadSchema,
  sendPayloadSchema,
  slowmodePayloadSchema,
  timeoutPayloadSchema,
  unbanPayloadSchema,
  unlockPayloadSchema,
  untimeoutPayloadSchema,
  warnPayloadSchema,
} from './payloads.ts';
import type { RestFile } from './rest-client.ts';
import type { ActionRequest } from './types.ts';

export interface RestCall {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  files?: RestFile[];
}

/**
 * What a kind maps to.
 *
 * `{ call }` for the fifteen kinds that hit Discord, `{ ledgerOnly: true }` for
 * the ones that do not (`warn`). The third arm is a validation failure. Modelled
 * as a union rather than an optional `call` so the executor cannot forget to
 * handle the no-call case — it has to narrow before it can reach `.call`.
 */
export type PayloadResult = { call: RestCall } | { ledgerOnly: true } | { error: string };

const LEDGER_ONLY: PayloadResult = { ledgerOnly: true };

/**
 * Turn validated attachments into multipart parts plus the `attachments[]`
 * descriptors that reference them.
 *
 * The index is the contract: part `files[2]` is described by the descriptor with
 * `id: 2`, and an embed refers to it as `attachment://<filename>`. One function
 * builds both halves so they cannot disagree.
 */
function toFiles(attachments: readonly Attachment[] | undefined): {
  files?: RestFile[];
  descriptors?: Array<{ id: number; filename: string; description?: string }>;
} {
  if (!attachments || attachments.length === 0) return {};

  return {
    files: attachments.map((file, index) => ({
      name: `files[${index}]`,
      filename: file.filename,
      contentType: file.contentType,
      data: file.data,
    })),
    descriptors: attachments.map((file, index) => ({
      id: index,
      filename: file.filename,
      ...(file.description !== undefined ? { description: file.description } : {}),
    })),
  };
}

/** Drop keys whose value is undefined, so an absent field is absent rather than null. */
function present<T extends Record<string, unknown>>(body: T): T {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as T;
}

function issues(request: ActionRequest, list: z.core.$ZodIssue[]): { error: string } {
  return {
    error: `Invalid payload for '${request.kind}': ${list
      .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
      .join('; ')}`,
  };
}

/**
 * Discord's audit log reason header.
 *
 * Populated for every moderation action so a server's own audit log explains
 * *why* Proton acted. Without it the log shows the bot doing things for no
 * stated reason, which is exactly the opacity §1 objects to.
 */
function auditHeaders(request: ActionRequest): Record<string, string> | undefined {
  if (!request.reason) return undefined;
  // Header values must be latin-1; encode so a reason with emoji cannot break
  // the request entirely.
  return { 'x-audit-log-reason': encodeURIComponent(request.reason).slice(0, 512) };
}

/**
 * Map a validated payload to the REST call that performs it.
 *
 * One exhaustive switch, so a new `ActionKind` cannot be added without the
 * compiler demanding both its schema and its endpoint. Keeping validation and
 * routing together is deliberate: split apart, they drift.
 */
export function toRestCall(request: ActionRequest): PayloadResult {
  const guild = request.guildId;
  const headers = auditHeaders(request);
  const withAudit = (call: RestCall): RestCall => (headers ? { ...call, headers } : call);

  switch (request.kind) {
    case 'send': {
      const p = sendPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);

      const { files, descriptors } = toFiles(p.data.files);
      return {
        call: {
          method: 'POST',
          path: `/channels/${p.data.channelId}/messages`,
          body: present({
            content: p.data.content,
            embeds: p.data.embeds,
            components: p.data.components,
            attachments: descriptors,
            // `fail_if_not_exists: false` so a starboard reply to a message that
            // has since been deleted posts anyway instead of 400ing.
            message_reference: p.data.replyToMessageId
              ? { message_id: p.data.replyToMessageId, fail_if_not_exists: false }
              : undefined,
          }),
          ...(files ? { files } : {}),
        },
      };
    }

    case 'edit_message': {
      const p = editMessagePayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: {
          method: 'PATCH',
          path: `/channels/${p.data.channelId}/messages/${p.data.messageId}`,
          body: present({
            content: p.data.content,
            embeds: p.data.embeds,
            components: p.data.components,
          }),
        },
      };
    }

    case 'delete_message': {
      const p = deleteMessagePayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'DELETE',
          path: `/channels/${p.data.channelId}/messages/${p.data.messageId}`,
        }),
      };
    }

    case 'add_reaction': {
      const p = addReactionPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      // The emoji is a path segment, so it must be encoded — a unicode star or a
      // `name:id` pair both contain characters that would otherwise split the path.
      return {
        call: {
          method: 'PUT',
          path: `/channels/${p.data.channelId}/messages/${p.data.messageId}/reactions/${encodeURIComponent(
            p.data.emoji,
          )}/@me`,
        },
      };
    }

    case 'interaction_reply': {
      const p = interactionReplyPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);

      // A deferral carries no data at all. Sending an empty `data` object with
      // one is accepted but pointless; sending `content: undefined` is not.
      const data = isDeferral(p.data.callbackType)
        ? p.data.ephemeral
          ? { flags: MESSAGE_FLAG_EPHEMERAL }
          : undefined
        : present({
            content: p.data.content,
            embeds: p.data.embeds,
            components: p.data.components,
            flags: p.data.ephemeral ? MESSAGE_FLAG_EPHEMERAL : undefined,
          });

      return {
        call: {
          method: 'POST',
          path: `/interactions/${p.data.interactionId}/${p.data.interactionToken}/callback`,
          body: present({ type: p.data.callbackType, data }),
        },
      };
    }

    case 'interaction_followup': {
      const p = interactionFollowupPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);

      const { files, descriptors } = toFiles(p.data.files);
      return {
        call: {
          method: 'POST',
          path: `/webhooks/${p.data.applicationId}/${p.data.interactionToken}`,
          body: present({
            content: p.data.content,
            embeds: p.data.embeds,
            components: p.data.components,
            attachments: descriptors,
            flags: p.data.ephemeral ? MESSAGE_FLAG_EPHEMERAL : undefined,
          }),
          ...(files ? { files } : {}),
        },
      };
    }

    /**
     * No REST call exists for "this member has been warned" — the state change
     * is the `cases` row. Validated here anyway so a malformed warn is refused
     * by the same path as any other bad payload rather than silently recording a
     * case about nobody.
     */
    case 'warn': {
      const p = warnPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return LEDGER_ONLY;
    }

    case 'ban': {
      const p = banPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'PUT',
          path: `/guilds/${guild}/bans/${p.data.userId}`,
          body: { delete_message_seconds: p.data.deleteMessageSeconds },
        }),
      };
    }

    case 'unban': {
      const p = unbanPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({ method: 'DELETE', path: `/guilds/${guild}/bans/${p.data.userId}` }),
      };
    }

    case 'kick': {
      const p = kickPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({ method: 'DELETE', path: `/guilds/${guild}/members/${p.data.userId}` }),
      };
    }

    case 'timeout': {
      const p = timeoutPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);

      const ms = p.data.until.getTime() - Date.now();
      if (ms > MAX_TIMEOUT_MS) {
        return {
          error: 'Discord caps timeouts at 28 days. Use a temporary ban for anything longer.',
        };
      }
      if (ms <= 0) {
        return { error: 'That timeout would expire immediately — pick a time in the future.' };
      }

      return {
        call: withAudit({
          method: 'PATCH',
          path: `/guilds/${guild}/members/${p.data.userId}`,
          body: { communication_disabled_until: p.data.until.toISOString() },
        }),
      };
    }

    case 'untimeout': {
      const p = untimeoutPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'PATCH',
          path: `/guilds/${guild}/members/${p.data.userId}`,
          body: { communication_disabled_until: null },
        }),
      };
    }

    case 'add_role': {
      const p = roleChangePayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'PUT',
          path: `/guilds/${guild}/members/${p.data.userId}/roles/${p.data.roleId}`,
        }),
      };
    }

    case 'remove_role': {
      const p = roleChangePayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'DELETE',
          path: `/guilds/${guild}/members/${p.data.userId}/roles/${p.data.roleId}`,
        }),
      };
    }

    case 'purge': {
      const p = purgePayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'POST',
          path: `/channels/${p.data.channelId}/messages/bulk-delete`,
          body: { messages: p.data.messageIds },
        }),
      };
    }

    case 'slowmode': {
      const p = slowmodePayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'PATCH',
          path: `/channels/${p.data.channelId}`,
          body: { rate_limit_per_user: p.data.seconds },
        }),
      };
    }

    case 'lockdown': {
      const p = lockdownPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      // Deny SEND_MESSAGES on top of whatever the overwrite already denied, so
      // a lockdown does not quietly clear unrelated restrictions.
      const deny = (BigInt(p.data.previousDeny) | (1n << 11n)).toString();
      return {
        call: withAudit({
          method: 'PUT',
          path: `/channels/${p.data.channelId}/permissions/${p.data.roleId}`,
          body: { type: 0, allow: p.data.previousAllow, deny },
        }),
      };
    }

    case 'unlock': {
      const p = unlockPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      // Restore exactly what was there, from what lockdown recorded (R4).
      return {
        call: withAudit({
          method: 'PUT',
          path: `/channels/${p.data.channelId}/permissions/${p.data.roleId}`,
          body: { type: 0, allow: p.data.restoreAllow, deny: p.data.restoreDeny },
        }),
      };
    }
  }
}

export type { ActionKind };
