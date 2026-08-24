import type { z } from 'zod';
import type { ActionKind } from './kinds.ts';
import {
  type Attachment,
  AUTOMOD_ACTION_BLOCK_MESSAGE,
  AUTOMOD_ACTION_SEND_ALERT,
  AUTOMOD_ACTION_TIMEOUT,
  type AutomodRuleAction,
  type AutomodTriggerMetadata,
  addReactionPayloadSchema,
  automodRuleCreatePayloadSchema,
  automodRuleDeletePayloadSchema,
  automodRuleUpdatePayloadSchema,
  banPayloadSchema,
  createChannelPayloadSchema,
  createDmPayloadSchema,
  createRolePayloadSchema,
  createThreadPayloadSchema,
  deleteChannelPayloadSchema,
  deleteMessagePayloadSchema,
  editChannelPayloadSchema,
  editMessagePayloadSchema,
  endPollPayloadSchema,
  giveawayDrawPayloadSchema,
  INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT,
  INTERACTION_CALLBACK_MODAL,
  type InteractionReplyPayload,
  interactionFollowupPayloadSchema,
  interactionReplyPayloadSchema,
  isDeferral,
  kickPayloadSchema,
  lockdownPayloadSchema,
  MAX_TIMEOUT_MS,
  MESSAGE_FLAG_EPHEMERAL,
  moveMemberPayloadSchema,
  pinMessagePayloadSchema,
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

export type PayloadResult = { call: RestCall } | { ledgerOnly: true } | { error: string };

const LEDGER_ONLY: PayloadResult = { ledgerOnly: true };

export const AUDIT_REASON_MAX = 512;

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

function automodActions(actions: readonly AutomodRuleAction[]): unknown[] {
  return actions.map((action) => {
    switch (action.type) {
      case AUTOMOD_ACTION_BLOCK_MESSAGE:
        return {
          type: action.type,
          metadata: present({ custom_message: action.customMessage }),
        };
      case AUTOMOD_ACTION_SEND_ALERT:
        return { type: action.type, metadata: { channel_id: action.channelId } };
      case AUTOMOD_ACTION_TIMEOUT:
        return { type: action.type, metadata: { duration_seconds: action.durationSeconds } };
      default:
        return { type: action.type };
    }
  });
}

function automodMetadata(metadata: AutomodTriggerMetadata): Record<string, unknown> {
  return present({
    keyword_filter: metadata.keywordFilter,
    regex_patterns: metadata.regexPatterns,
    presets: metadata.presets,
    allow_list: metadata.allowList,
    mention_total_limit: metadata.mentionTotalLimit,
    mention_raid_protection_enabled: metadata.mentionRaidProtectionEnabled,
  });
}

function interactionCallbackData(
  payload: InteractionReplyPayload,
  descriptors: Array<{ id: number; filename: string; description?: string }> | undefined,
): unknown {
  const modal = payload.modal;
  if (payload.callbackType === INTERACTION_CALLBACK_MODAL && modal) {
    return { custom_id: modal.customId, title: modal.title, components: modal.components };
  }

  if (payload.callbackType === INTERACTION_CALLBACK_AUTOCOMPLETE_RESULT) {
    return { choices: payload.choices ?? [] };
  }

  if (isDeferral(payload.callbackType)) {
    return payload.ephemeral ? { flags: MESSAGE_FLAG_EPHEMERAL } : undefined;
  }

  // Or'd, not overwritten: an ephemeral components-v2 reply needs both bits, and dropping either
  // one makes Discord reject the whole callback.
  const flags = (payload.ephemeral ? MESSAGE_FLAG_EPHEMERAL : 0) | (payload.flags ?? 0);

  return present({
    content: payload.content,
    embeds: payload.embeds,
    components: payload.components,
    attachments: descriptors,
    allowed_mentions: payload.allowedMentions,
    flags: flags === 0 ? undefined : flags,
  });
}

function auditHeaders(request: ActionRequest): Record<string, string> | undefined {
  if (!request.reason) return undefined;

  // Sliced before encoding, never after. Discord counts the 512 against the decoded reason, and a
  // cut through a percent-escape leaves a tail like '%2' that decodes to nothing at all.
  return { 'x-audit-log-reason': encodeURIComponent(request.reason.slice(0, AUDIT_REASON_MAX)) };
}

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
            poll: p.data.poll,
            flags: p.data.flags,
            allowed_mentions: p.data.allowedMentions,

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
            flags: p.data.flags,
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

      const { files, descriptors } = toFiles(p.data.files);

      const data = interactionCallbackData(p.data, descriptors);

      return {
        call: {
          method: 'POST',
          path: `/interactions/${p.data.interactionId}/${p.data.interactionToken}/callback`,
          body: present({ type: p.data.callbackType, data }),
          ...(files ? { files } : {}),
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
            allowed_mentions: p.data.allowedMentions,
            // Or'd, like the callback above: the schema validates componentsV2IsExclusive against
            // this field, so discarding it let a V2 followup pass validation and then reach Discord
            // without the bit that makes its components legal.
            flags:
              (p.data.ephemeral ? MESSAGE_FLAG_EPHEMERAL : 0) | (p.data.flags ?? 0) || undefined,
          }),
          ...(files ? { files } : {}),
        },
      };
    }

    // Ledger-only: it changes who won, not anything on Discord. The announcement that follows is
    // an ordinary send with its own idempotency key. Still validated — an unreadable audit row is
    // the one thing a draw record cannot be.
    case 'giveaway_draw': {
      const p = giveawayDrawPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return LEDGER_ONLY;
    }

    // Two calls make a DM: this opens the channel and returns its id in ActionResult.body, and
    // the caller sends into it. Modelling it as one kind would need a two-step RestCall.
    case 'create_dm': {
      const p = createDmPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);

      return {
        call: {
          method: 'POST',
          path: '/users/@me/channels',
          body: { recipient_id: p.data.userId },
        },
      };
    }

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

      return {
        call: withAudit({
          method: 'PUT',
          path: `/channels/${p.data.channelId}/permissions/${p.data.roleId}`,
          body: { type: 0, allow: p.data.restoreAllow, deny: p.data.restoreDeny },
        }),
      };
    }

    case 'create_channel': {
      const p = createChannelPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'POST',
          path: `/guilds/${guild}/channels`,
          body: present({
            name: p.data.name,
            type: p.data.type,
            parent_id: p.data.parentId,
            position: p.data.position,
            topic: p.data.topic,
            nsfw: p.data.nsfw,
            rate_limit_per_user: p.data.rateLimitPerUser,
            permission_overwrites: p.data.permissionOverwrites,
            user_limit: p.data.userLimit,
            bitrate: p.data.bitrate,
          }),
        }),
      };
    }

    case 'create_role': {
      const p = createRolePayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'POST',
          path: `/guilds/${guild}/roles`,
          body: present({
            name: p.data.name,
            permissions: p.data.permissions,
            color: p.data.color,
            hoist: p.data.hoist,
            mentionable: p.data.mentionable,
          }),
        }),
      };
    }

    case 'delete_channel': {
      const p = deleteChannelPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({ method: 'DELETE', path: `/channels/${p.data.channelId}` }),
      };
    }

    case 'edit_channel': {
      const p = editChannelPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'PATCH',
          path: `/channels/${p.data.channelId}`,
          body: present({
            name: p.data.name,
            user_limit: p.data.userLimit,
            bitrate: p.data.bitrate,
            topic: p.data.topic,
            parent_id: p.data.parentId,
            rate_limit_per_user: p.data.rateLimitPerUser,
            permission_overwrites: p.data.permissionOverwrites,
          }),
        }),
      };
    }

    case 'create_thread': {
      const p = createThreadPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'POST',
          path: `/channels/${p.data.channelId}/threads`,
          body: present({
            name: p.data.name,
            type: p.data.type,
            auto_archive_duration: p.data.autoArchiveDuration,
            invitable: p.data.invitable,
            rate_limit_per_user: p.data.rateLimitPerUser,
          }),
        }),
      };
    }

    case 'move_member': {
      const p = moveMemberPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'PATCH',
          path: `/guilds/${guild}/members/${p.data.userId}`,
          body: { channel_id: p.data.channelId },
        }),
      };
    }

    case 'end_poll': {
      const p = endPollPayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: {
          method: 'POST',
          path: `/channels/${p.data.channelId}/polls/${p.data.messageId}/expire`,
        },
      };
    }

    case 'pin_message': {
      const p = pinMessagePayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'PUT',
          path: `/channels/${p.data.channelId}/messages/pins/${p.data.messageId}`,
        }),
      };
    }

    case 'automod_rule_create': {
      const p = automodRuleCreatePayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'POST',
          path: `/guilds/${guild}/auto-moderation/rules`,
          body: {
            name: p.data.name,
            event_type: p.data.eventType,
            trigger_type: p.data.triggerType,
            trigger_metadata: automodMetadata(p.data.triggerMetadata),
            actions: automodActions(p.data.actions),
            enabled: p.data.enabled,
            exempt_roles: p.data.exemptRoles,
            exempt_channels: p.data.exemptChannels,
          },
        }),
      };
    }

    case 'automod_rule_update': {
      const p = automodRuleUpdatePayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'PATCH',
          path: `/guilds/${guild}/auto-moderation/rules/${p.data.ruleId}`,
          body: {
            name: p.data.name,
            event_type: p.data.eventType,
            trigger_metadata: automodMetadata(p.data.triggerMetadata),
            actions: automodActions(p.data.actions),
            enabled: p.data.enabled,
            exempt_roles: p.data.exemptRoles,
            exempt_channels: p.data.exemptChannels,
          },
        }),
      };
    }

    case 'automod_rule_delete': {
      const p = automodRuleDeletePayloadSchema.safeParse(request.payload);
      if (!p.success) return issues(request, p.error.issues);
      return {
        call: withAudit({
          method: 'DELETE',
          path: `/guilds/${guild}/auto-moderation/rules/${p.data.ruleId}`,
        }),
      };
    }
  }
}

export type { ActionKind };
