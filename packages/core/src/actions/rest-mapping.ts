import type { z } from 'zod';
import type { ActionKind } from './kinds.ts';
import {
  banPayloadSchema,
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  interactionReplyPayloadSchema,
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
} from './payloads.ts';
import type { ActionRequest } from './types.ts';

export interface RestCall {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export type PayloadResult = { call: RestCall } | { error: string };

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
      return {
        call: {
          method: 'POST',
          path: `/channels/${p.data.channelId}/messages`,
          body: { content: p.data.content },
        },
      };
    }

    case 'interaction_reply': {
      const p = interactionReplyPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: {
          method: 'POST',
          path: `/interactions/${p.data.interactionId}/${p.data.interactionToken}/callback`,
          body: {
            type: INTERACTION_CALLBACK_CHANNEL_MESSAGE,
            data: {
              content: p.data.content,
              ...(p.data.ephemeral ? { flags: MESSAGE_FLAG_EPHEMERAL } : {}),
            },
          },
        },
      };
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
