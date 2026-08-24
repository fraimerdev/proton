import type { EventType } from '@proton/core';
import { AuditLogEvent } from 'discord-api-types/v10';
import { ServerLogColors } from './colours.ts';
import {
  renderAutomodBlocked,
  renderAutomodFlagged,
  renderAutomodRuleCreated,
  renderAutomodRuleDeleted,
  renderAutomodRuleUpdated,
  renderAutomodTimedOut,
  renderCommandPermissionsUpdated,
  renderEmojiCreated,
  renderEmojiDeleted,
  renderEmojiUpdated,
  renderHomeSettingsUpdated,
  renderIntegrationCreated,
  renderIntegrationDeleted,
  renderIntegrationUpdated,
  renderInviteCreated,
  renderInviteDeleted,
  renderMonetizationUpdated,
  renderOnboardingUpdated,
  renderScheduledEventCreated,
  renderScheduledEventDeleted,
  renderScheduledEventUpdated,
  renderServerUpdated,
  renderSoundboardCreated,
  renderSoundboardDeleted,
  renderSoundboardUpdated,
  renderStageEnded,
  renderStageStarted,
  renderStageUpdated,
  renderStickerCreated,
  renderStickerDeleted,
  renderStickerUpdated,
  renderWebhookCreated,
  renderWebhookDeleted,
  renderWebhookUpdated,
} from './render/audit-tail.ts';
import {
  renderChannelCreated,
  renderChannelDeleted,
  renderChannelUpdated,
  renderOverwriteCreated,
  renderOverwriteDeleted,
  renderOverwriteUpdated,
  renderThreadCreated,
  renderThreadDeleted,
  renderThreadUpdated,
} from './render/channels.ts';
import {
  renderMemberJoined,
  renderMemberLeft,
  renderNicknameChanged,
  renderRolesAdded,
  renderRolesRemoved,
  renderScreeningPassed,
} from './render/members.ts';
import {
  renderMessageDeleted,
  renderMessageEdited,
  renderMessagePinned,
  renderMessagesBulkDeleted,
  renderMessageUnpinned,
} from './render/messages.ts';
import {
  renderBotAdded,
  renderMemberBanned,
  renderMemberKicked,
  renderMembersPruned,
  renderMemberTimedOut,
  renderMemberUnbanned,
  renderTimeoutRemoved,
} from './render/moderation.ts';
import {
  renderActionExecuted,
  renderConfigChanged,
  renderModuleToggled,
  renderSecurityTripped,
} from './render/proton.ts';
import { renderRoleCreated, renderRoleDeleted, renderRoleUpdated } from './render/roles.ts';
import type { RenderInput, RenderResult } from './render/types.ts';
import {
  renderServerDeafened,
  renderServerMuted,
  renderVoiceDisconnectedByModerator,
  renderVoiceJoined,
  renderVoiceLeft,
  renderVoiceMovedByModerator,
} from './render/voice.ts';

export const LOG_CATEGORIES = [
  'server',
  'channels',
  'roles',
  'members',
  'messages',
  'voice',
  'moderation',
  'invites',
  'integrations',
  'expressions',
  'events',
  'automod',
  'proton',
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];

export type LogPrimary = 'entity' | 'audit' | 'immediate';

export interface LogEventSpec {
  key: string;
  category: LogCategory;
  label: string;
  colour: number;

  triggers: EventType[];

  auditActions?: number[];

  primary: LogPrimary;

  // A kick emits GUILD_MEMBER_REMOVE as well as its audit entry. When the entry turns up inside
  // the correlation window the leave is dropped, because the kick log says strictly more.
  suppressWhenCorrelated?: boolean;

  targetId?(entity: unknown): string | null;

  render(input: RenderInput): RenderResult | null;
}

function idOf(entity: unknown): string | null {
  if (typeof entity !== 'object' || entity === null) return null;
  const value = (entity as Record<string, unknown>).id;

  return typeof value === 'string' ? value : null;
}

function roleIdOf(entity: unknown): string | null {
  if (typeof entity !== 'object' || entity === null) return null;
  const payload = entity as Record<string, unknown>;

  const role = payload.role;
  if (typeof role === 'object' && role !== null) {
    const id = (role as Record<string, unknown>).id;
    if (typeof id === 'string') return id;
  }

  return typeof payload.role_id === 'string' ? payload.role_id : null;
}

function userIdOf(entity: unknown): string | null {
  if (typeof entity !== 'object' || entity === null) return null;
  const user = (entity as Record<string, unknown>).user;
  if (typeof user !== 'object' || user === null) return null;

  const id = (user as Record<string, unknown>).id;
  return typeof id === 'string' ? id : null;
}

const SPECS: LogEventSpec[] = [
  {
    key: 'channels.created',
    category: 'channels',
    label: 'Channel created',
    colour: ServerLogColors.Add,
    triggers: ['entity.channel_created'],
    auditActions: [AuditLogEvent.ChannelCreate],
    primary: 'entity',
    targetId: idOf,
    render: renderChannelCreated,
  },
  {
    key: 'channels.updated',
    category: 'channels',
    label: 'Channel updated',
    colour: ServerLogColors.Modify,
    triggers: ['entity.channel_updated'],
    auditActions: [AuditLogEvent.ChannelUpdate],
    primary: 'entity',
    targetId: idOf,
    render: renderChannelUpdated,
  },
  {
    key: 'channels.deleted',
    category: 'channels',
    label: 'Channel deleted',
    colour: ServerLogColors.Remove,
    triggers: ['entity.channel_deleted'],
    auditActions: [AuditLogEvent.ChannelDelete],
    primary: 'entity',
    targetId: idOf,
    render: renderChannelDeleted,
  },
  {
    key: 'channels.thread_created',
    category: 'channels',
    label: 'Thread created',
    colour: ServerLogColors.Add,
    triggers: ['entity.thread_created'],
    auditActions: [AuditLogEvent.ThreadCreate],
    primary: 'entity',
    targetId: idOf,
    render: renderThreadCreated,
  },
  {
    key: 'channels.thread_updated',
    category: 'channels',
    label: 'Thread updated',
    colour: ServerLogColors.Modify,
    triggers: ['entity.thread_updated'],
    auditActions: [AuditLogEvent.ThreadUpdate],
    primary: 'entity',
    targetId: idOf,
    render: renderThreadUpdated,
  },
  {
    key: 'channels.thread_deleted',
    category: 'channels',
    label: 'Thread deleted',
    colour: ServerLogColors.Remove,
    triggers: ['entity.thread_deleted'],
    auditActions: [AuditLogEvent.ThreadDelete],
    primary: 'entity',
    targetId: idOf,
    render: renderThreadDeleted,
  },
  {
    key: 'channels.overwrite_created',
    category: 'channels',
    label: 'Channel permission added',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.ChannelOverwriteCreate],
    primary: 'audit',
    render: renderOverwriteCreated,
  },
  {
    key: 'channels.overwrite_updated',
    category: 'channels',
    label: 'Channel permission changed',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.ChannelOverwriteUpdate],
    primary: 'audit',
    render: renderOverwriteUpdated,
  },
  {
    key: 'channels.overwrite_deleted',
    category: 'channels',
    label: 'Channel permission removed',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.ChannelOverwriteDelete],
    primary: 'audit',
    render: renderOverwriteDeleted,
  },

  {
    key: 'roles.created',
    category: 'roles',
    label: 'Role created',
    colour: ServerLogColors.Add,
    triggers: ['entity.role_created'],
    auditActions: [AuditLogEvent.RoleCreate],
    primary: 'entity',
    targetId: roleIdOf,
    render: renderRoleCreated,
  },
  {
    key: 'roles.updated',
    category: 'roles',
    label: 'Role updated',
    colour: ServerLogColors.Modify,
    triggers: ['entity.role_updated'],
    auditActions: [AuditLogEvent.RoleUpdate],
    primary: 'entity',
    targetId: roleIdOf,
    render: renderRoleUpdated,
  },
  {
    key: 'roles.deleted',
    category: 'roles',
    label: 'Role deleted',
    colour: ServerLogColors.Remove,
    triggers: ['entity.role_deleted'],
    auditActions: [AuditLogEvent.RoleDelete],
    primary: 'entity',
    targetId: roleIdOf,
    render: renderRoleDeleted,
  },

  {
    key: 'members.joined',
    category: 'members',
    label: 'Member joined',
    colour: ServerLogColors.Add,
    triggers: ['member.joined'],
    primary: 'immediate',
    render: renderMemberJoined,
  },
  {
    key: 'members.left',
    category: 'members',
    label: 'Member left',
    colour: ServerLogColors.Remove,
    triggers: ['member.left'],
    auditActions: [AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd],
    primary: 'entity',
    suppressWhenCorrelated: true,
    targetId: userIdOf,
    render: renderMemberLeft,
  },
  {
    key: 'members.screening_passed',
    category: 'members',
    label: 'Member accepted the rules',
    colour: ServerLogColors.Modify,
    triggers: ['member.updated'],
    primary: 'immediate',
    render: renderScreeningPassed,
  },
  {
    key: 'members.nickname_changed',
    category: 'members',
    label: 'Nickname changed',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MemberUpdate],
    primary: 'audit',
    render: renderNicknameChanged,
  },
  {
    key: 'members.roles_added',
    category: 'members',
    label: 'Roles given to a member',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MemberRoleUpdate],
    primary: 'audit',
    render: renderRolesAdded,
  },
  {
    key: 'members.roles_removed',
    category: 'members',
    label: 'Roles taken from a member',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MemberRoleUpdate],
    primary: 'audit',
    render: renderRolesRemoved,
  },

  {
    key: 'messages.edited',
    category: 'messages',
    label: 'Message edited',
    colour: ServerLogColors.Modify,
    triggers: ['message.updated'],
    primary: 'immediate',
    render: renderMessageEdited,
  },
  {
    key: 'messages.deleted',
    category: 'messages',
    label: 'Message deleted',
    colour: ServerLogColors.Remove,
    triggers: ['message.deleted'],
    auditActions: [AuditLogEvent.MessageDelete],
    primary: 'entity',
    targetId: idOf,
    render: renderMessageDeleted,
  },
  {
    key: 'messages.bulk_deleted',
    category: 'messages',
    label: 'Messages bulk deleted',
    colour: ServerLogColors.Remove,
    triggers: ['message.bulk_deleted'],
    primary: 'immediate',
    render: renderMessagesBulkDeleted,
  },
  {
    key: 'messages.pinned',
    category: 'messages',
    label: 'Message pinned',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MessagePin],
    primary: 'audit',
    render: renderMessagePinned,
  },
  {
    key: 'messages.unpinned',
    category: 'messages',
    label: 'Message unpinned',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MessageUnpin],
    primary: 'audit',
    render: renderMessageUnpinned,
  },

  {
    key: 'voice.joined',
    category: 'voice',
    label: 'Joined a voice channel',
    colour: ServerLogColors.Add,
    triggers: ['voice.state_updated'],
    primary: 'immediate',
    render: renderVoiceJoined,
  },
  {
    key: 'voice.left',
    category: 'voice',
    label: 'Left voice',
    colour: ServerLogColors.Remove,
    triggers: ['voice.state_updated'],
    primary: 'immediate',
    render: renderVoiceLeft,
  },
  {
    key: 'voice.moved_by_moderator',
    category: 'voice',
    label: 'Moved between voice channels',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MemberMove],
    primary: 'audit',
    render: renderVoiceMovedByModerator,
  },
  {
    key: 'voice.disconnected_by_moderator',
    category: 'voice',
    label: 'Disconnected from voice',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MemberDisconnect],
    primary: 'audit',
    render: renderVoiceDisconnectedByModerator,
  },
  {
    key: 'voice.server_muted',
    category: 'voice',
    label: 'Server mute changed',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MemberUpdate],
    primary: 'audit',
    render: renderServerMuted,
  },
  {
    key: 'voice.server_deafened',
    category: 'voice',
    label: 'Server deafen changed',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MemberUpdate],
    primary: 'audit',
    render: renderServerDeafened,
  },

  {
    key: 'moderation.member_banned',
    category: 'moderation',
    label: 'Member banned',
    colour: ServerLogColors.Remove,
    triggers: ['entity.ban_added'],
    auditActions: [AuditLogEvent.MemberBanAdd],
    primary: 'entity',
    targetId: userIdOf,
    render: renderMemberBanned,
  },
  {
    key: 'moderation.member_unbanned',
    category: 'moderation',
    label: 'Member unbanned',
    colour: ServerLogColors.Add,
    triggers: ['entity.ban_removed'],
    auditActions: [AuditLogEvent.MemberBanRemove],
    primary: 'entity',
    targetId: userIdOf,
    render: renderMemberUnbanned,
  },
  {
    key: 'moderation.member_kicked',
    category: 'moderation',
    label: 'Member kicked',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MemberKick],
    primary: 'audit',
    render: renderMemberKicked,
  },
  {
    key: 'moderation.members_pruned',
    category: 'moderation',
    label: 'Inactive members pruned',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MemberPrune],
    primary: 'audit',
    render: renderMembersPruned,
  },
  {
    key: 'moderation.member_timed_out',
    category: 'moderation',
    label: 'Member timed out',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MemberUpdate],
    primary: 'audit',
    render: renderMemberTimedOut,
  },
  {
    key: 'moderation.timeout_removed',
    category: 'moderation',
    label: 'Timeout removed',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.MemberUpdate],
    primary: 'audit',
    render: renderTimeoutRemoved,
  },
  {
    key: 'moderation.bot_added',
    category: 'moderation',
    label: 'Bot added',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.BotAdd],
    primary: 'audit',
    render: renderBotAdded,
  },

  {
    key: 'server.updated',
    category: 'server',
    label: 'Server settings changed',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.GuildUpdate],
    primary: 'audit',
    render: renderServerUpdated,
  },
  {
    key: 'server.onboarding_updated',
    category: 'server',
    label: 'Onboarding changed',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [
      AuditLogEvent.OnboardingPromptCreate,
      AuditLogEvent.OnboardingPromptUpdate,
      AuditLogEvent.OnboardingPromptDelete,
      AuditLogEvent.OnboardingCreate,
      AuditLogEvent.OnboardingUpdate,
    ],
    primary: 'audit',
    render: renderOnboardingUpdated,
  },
  {
    key: 'server.command_permissions_updated',
    category: 'server',
    label: 'Command permissions changed',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.ApplicationCommandPermissionUpdate],
    primary: 'audit',
    render: renderCommandPermissionsUpdated,
  },
  {
    key: 'server.monetization_updated',
    category: 'server',
    label: 'Monetization changed',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [
      AuditLogEvent.CreatorMonetizationRequestCreated,
      AuditLogEvent.CreatorMonetizationTermsAccepted,
    ],
    primary: 'audit',
    render: renderMonetizationUpdated,
  },
  {
    key: 'server.home_settings_updated',
    category: 'server',
    label: 'Server guide changed',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.HomeSettingsCreate, AuditLogEvent.HomeSettingsUpdate],
    primary: 'audit',
    render: renderHomeSettingsUpdated,
  },
  {
    key: 'invites.created',
    category: 'invites',
    label: 'Invite created',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.InviteCreate],
    primary: 'audit',
    render: renderInviteCreated,
  },
  {
    key: 'invites.deleted',
    category: 'invites',
    label: 'Invite deleted',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.InviteDelete],
    primary: 'audit',
    render: renderInviteDeleted,
  },
  {
    key: 'integrations.webhook_created',
    category: 'integrations',
    label: 'Webhook created',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.WebhookCreate],
    primary: 'audit',
    render: renderWebhookCreated,
  },
  {
    key: 'integrations.webhook_updated',
    category: 'integrations',
    label: 'Webhook updated',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.WebhookUpdate],
    primary: 'audit',
    render: renderWebhookUpdated,
  },
  {
    key: 'integrations.webhook_deleted',
    category: 'integrations',
    label: 'Webhook deleted',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.WebhookDelete],
    primary: 'audit',
    render: renderWebhookDeleted,
  },
  {
    key: 'integrations.created',
    category: 'integrations',
    label: 'Integration added',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.IntegrationCreate],
    primary: 'audit',
    render: renderIntegrationCreated,
  },
  {
    key: 'integrations.updated',
    category: 'integrations',
    label: 'Integration updated',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.IntegrationUpdate],
    primary: 'audit',
    render: renderIntegrationUpdated,
  },
  {
    key: 'integrations.deleted',
    category: 'integrations',
    label: 'Integration removed',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.IntegrationDelete],
    primary: 'audit',
    render: renderIntegrationDeleted,
  },
  {
    key: 'expressions.emoji_created',
    category: 'expressions',
    label: 'Emoji created',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.EmojiCreate],
    primary: 'audit',
    render: renderEmojiCreated,
  },
  {
    key: 'expressions.emoji_updated',
    category: 'expressions',
    label: 'Emoji renamed',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.EmojiUpdate],
    primary: 'audit',
    render: renderEmojiUpdated,
  },
  {
    key: 'expressions.emoji_deleted',
    category: 'expressions',
    label: 'Emoji deleted',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.EmojiDelete],
    primary: 'audit',
    render: renderEmojiDeleted,
  },
  {
    key: 'expressions.sticker_created',
    category: 'expressions',
    label: 'Sticker created',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.StickerCreate],
    primary: 'audit',
    render: renderStickerCreated,
  },
  {
    key: 'expressions.sticker_updated',
    category: 'expressions',
    label: 'Sticker updated',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.StickerUpdate],
    primary: 'audit',
    render: renderStickerUpdated,
  },
  {
    key: 'expressions.sticker_deleted',
    category: 'expressions',
    label: 'Sticker deleted',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.StickerDelete],
    primary: 'audit',
    render: renderStickerDeleted,
  },
  {
    key: 'expressions.soundboard_created',
    category: 'expressions',
    label: 'Soundboard sound added',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.SoundboardSoundCreate],
    primary: 'audit',
    render: renderSoundboardCreated,
  },
  {
    key: 'expressions.soundboard_updated',
    category: 'expressions',
    label: 'Soundboard sound updated',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.SoundboardSoundUpdate],
    primary: 'audit',
    render: renderSoundboardUpdated,
  },
  {
    key: 'expressions.soundboard_deleted',
    category: 'expressions',
    label: 'Soundboard sound removed',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.SoundboardSoundDelete],
    primary: 'audit',
    render: renderSoundboardDeleted,
  },
  {
    key: 'events.scheduled_created',
    category: 'events',
    label: 'Event scheduled',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.GuildScheduledEventCreate],
    primary: 'audit',
    render: renderScheduledEventCreated,
  },
  {
    key: 'events.scheduled_updated',
    category: 'events',
    label: 'Event updated',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.GuildScheduledEventUpdate],
    primary: 'audit',
    render: renderScheduledEventUpdated,
  },
  {
    key: 'events.scheduled_deleted',
    category: 'events',
    label: 'Event cancelled',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.GuildScheduledEventDelete],
    primary: 'audit',
    render: renderScheduledEventDeleted,
  },
  {
    key: 'events.stage_started',
    category: 'events',
    label: 'Stage started',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.StageInstanceCreate],
    primary: 'audit',
    render: renderStageStarted,
  },
  {
    key: 'events.stage_updated',
    category: 'events',
    label: 'Stage updated',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.StageInstanceUpdate],
    primary: 'audit',
    render: renderStageUpdated,
  },
  {
    key: 'events.stage_ended',
    category: 'events',
    label: 'Stage ended',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.StageInstanceDelete],
    primary: 'audit',
    render: renderStageEnded,
  },
  {
    key: 'automod.rule_created',
    category: 'automod',
    label: 'AutoMod rule created',
    colour: ServerLogColors.Add,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.AutoModerationRuleCreate],
    primary: 'audit',
    render: renderAutomodRuleCreated,
  },
  {
    key: 'automod.rule_updated',
    category: 'automod',
    label: 'AutoMod rule updated',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.AutoModerationRuleUpdate],
    primary: 'audit',
    render: renderAutomodRuleUpdated,
  },
  {
    key: 'automod.rule_deleted',
    category: 'automod',
    label: 'AutoMod rule deleted',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.AutoModerationRuleDelete],
    primary: 'audit',
    render: renderAutomodRuleDeleted,
  },
  {
    key: 'automod.message_blocked',
    category: 'automod',
    label: 'AutoMod blocked a message',
    colour: ServerLogColors.Remove,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.AutoModerationBlockMessage],
    primary: 'audit',
    render: renderAutomodBlocked,
  },
  {
    key: 'automod.message_flagged',
    category: 'automod',
    label: 'AutoMod flagged a message',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.AutoModerationFlagToChannel],
    primary: 'audit',
    render: renderAutomodFlagged,
  },
  {
    key: 'automod.user_timed_out',
    category: 'automod',
    label: 'AutoMod timed a member out',
    colour: ServerLogColors.Modify,
    triggers: ['audit.entry'],
    auditActions: [AuditLogEvent.AutoModerationUserCommunicationDisabled],
    primary: 'audit',
    render: renderAutomodTimedOut,
  },

  {
    key: 'proton.config_changed',
    category: 'proton',
    label: 'Module settings changed',
    colour: ServerLogColors.Modify,
    triggers: ['proton.config_changed'],
    primary: 'immediate',
    render: renderConfigChanged,
  },
  {
    key: 'proton.module_toggled',
    category: 'proton',
    label: 'Module switched on or off',
    colour: ServerLogColors.Modify,
    triggers: ['proton.config_changed'],
    primary: 'immediate',
    render: renderModuleToggled,
  },
  {
    key: 'proton.action_executed',
    category: 'proton',
    label: 'Proton took a moderation action',
    colour: ServerLogColors.Modify,
    triggers: ['proton.action_executed'],
    primary: 'immediate',
    render: renderActionExecuted,
  },
  {
    key: 'proton.security_tripped',
    category: 'proton',
    label: 'A security module tripped',
    colour: ServerLogColors.Remove,
    triggers: ['proton.security_tripped'],
    primary: 'immediate',
    render: renderSecurityTripped,
  },
];

export const LOG_EVENTS: Readonly<Record<string, LogEventSpec>> = Object.freeze(
  Object.fromEntries(SPECS.map((spec) => [spec.key, spec])),
);

export const LOG_EVENT_KEYS: readonly string[] = SPECS.map((spec) => spec.key);

const KEY_SET: ReadonlySet<string> = new Set(LOG_EVENT_KEYS);

export function isLogEventKey(value: string): boolean {
  return KEY_SET.has(value);
}

export const LOG_TRIGGER_TYPES: readonly EventType[] = [
  ...new Set(SPECS.flatMap((spec) => spec.triggers)),
];

export function specsForEvent(type: EventType): LogEventSpec[] {
  return SPECS.filter((spec) => spec.triggers.includes(type));
}

export function specsForAuditAction(actionType: number): LogEventSpec[] {
  return SPECS.filter(
    (spec) => spec.primary === 'audit' && (spec.auditActions ?? []).includes(actionType),
  );
}

export function entitySpecsForAuditAction(actionType: number): LogEventSpec[] {
  return SPECS.filter(
    (spec) => spec.primary === 'entity' && (spec.auditActions ?? []).includes(actionType),
  );
}

export function specByKey(key: string): LogEventSpec | undefined {
  return LOG_EVENTS[key];
}

export function categoryOf(key: string): LogCategory | null {
  return LOG_EVENTS[key]?.category ?? null;
}
