import { ServerLogColors } from '../colours.ts';
import { channelMention, type LogField, type LogLine, logEmbed, userMention } from '../embed.ts';
import { display, type RenderInput, type RenderResult, str } from './types.ts';

// Everything in here is audit-primary: Discord's entry already carries the target, the executor,
// the reason and a `changes` diff, so no entity dispatch and no correlation is needed.

const NO_REASON = 'No reason given';

function reasonLine(input: RenderInput): LogLine {
  return { label: 'Reason', value: input.audit?.reason ?? NO_REASON };
}

function changeFields(input: RenderInput, labels: Record<string, string>): LogField[] {
  const fields: LogField[] = [];

  for (const change of input.audit?.changes ?? []) {
    const label = labels[change.key];
    if (!label) continue;

    const before = change.old_value === undefined ? 'none' : display(change.old_value);
    const after = change.new_value === undefined ? 'none' : display(change.new_value);
    fields.push({ name: label, value: `${before} → ${after}` });
  }

  return fields;
}

function nameOf(input: RenderInput): string | undefined {
  for (const change of input.audit?.changes ?? []) {
    if (change.key !== 'name') continue;
    return str(change.new_value) ?? str(change.old_value);
  }
  return undefined;
}

interface TailOptions {
  subject: string;
  action: string;
  colour: number;

  targetLabel?: string;
  mention?: (targetId: string) => string;
  changeLabels?: Record<string, string>;
  withReason?: boolean;
}

function tail(input: RenderInput, options: TailOptions): RenderResult | null {
  const audit = input.audit;
  if (!audit) return null;

  const lines: LogLine[] = [];
  const name = nameOf(input);

  if (name !== undefined) lines.push({ label: 'Name', value: name });

  if (audit.targetId) {
    lines.push({
      label: options.targetLabel ?? 'Id',
      ...(options.mention ? { mention: options.mention(audit.targetId) } : {}),
      value: audit.targetId,
    });
  }

  if (options.withReason !== false) lines.push(reasonLine(input));
  if (lines.length === 0) lines.push({ label: 'Server', value: audit.guildId });

  const fields = options.changeLabels ? changeFields(input, options.changeLabels) : [];

  return {
    embed: logEmbed({
      subject: options.subject,
      action: options.action,
      colour: options.colour,
      lines,
      ...(fields.length > 0 ? { fields } : {}),
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

const GUILD_KEYS: Record<string, string> = {
  name: 'Name',
  icon_hash: 'Icon',
  owner_id: 'Owner',
  verification_level: 'Verification level',
  explicit_content_filter: 'Content filter',
  default_message_notifications: 'Default notifications',
  afk_channel_id: 'AFK channel',
  afk_timeout: 'AFK timeout',
  system_channel_id: 'System channel',
  rules_channel_id: 'Rules channel',
  vanity_url_code: 'Vanity invite',
  mfa_level: 'Moderator 2FA',
  premium_progress_bar_enabled: 'Boost progress bar',
};

export function renderServerUpdated(input: RenderInput): RenderResult | null {
  const fields = changeFields(input, GUILD_KEYS);
  if (fields.length === 0) return null;

  return {
    embed: logEmbed({
      subject: 'Server',
      action: 'updated',
      colour: ServerLogColors.Modify,
      lines: [{ label: 'Changed', value: fields.map((field) => field.name).join(', ') }],
      fields,
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export const renderOnboardingUpdated = (input: RenderInput): RenderResult | null =>
  tail(input, { subject: 'Onboarding', action: 'updated', colour: ServerLogColors.Modify });

export const renderCommandPermissionsUpdated = (input: RenderInput): RenderResult | null =>
  tail(input, {
    subject: 'Command permissions',
    action: 'updated',
    colour: ServerLogColors.Modify,
  });

export const renderMonetizationUpdated = (input: RenderInput): RenderResult | null =>
  tail(input, { subject: 'Monetization', action: 'updated', colour: ServerLogColors.Modify });

export const renderHomeSettingsUpdated = (input: RenderInput): RenderResult | null =>
  tail(input, { subject: 'Server guide', action: 'updated', colour: ServerLogColors.Modify });

const INVITE_KEYS: Record<string, string> = {
  code: 'Code',
  channel_id: 'Channel',
  inviter_id: 'Created by',
  max_uses: 'Maximum uses',
  max_age: 'Expires after',
  temporary: 'Temporary membership',
  uses: 'Uses',
};

function inviteCode(input: RenderInput): string | undefined {
  for (const change of input.audit?.changes ?? []) {
    if (change.key !== 'code') continue;
    return str(change.new_value) ?? str(change.old_value);
  }
  return undefined;
}

function inviteEmbed(
  input: RenderInput,
  action: 'created' | 'deleted',
  colour: number,
): RenderResult | null {
  const audit = input.audit;
  if (!audit) return null;

  const code = inviteCode(input);

  return {
    embed: logEmbed({
      subject: 'Invite',
      action,
      colour,
      lines: [{ label: 'Code', value: code ?? 'unknown' }, reasonLine(input)],
      ...(action === 'created' ? { fields: changeFields(input, INVITE_KEYS) } : {}),
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export const renderInviteCreated = (input: RenderInput): RenderResult | null =>
  inviteEmbed(input, 'created', ServerLogColors.Add);

export const renderInviteDeleted = (input: RenderInput): RenderResult | null =>
  inviteEmbed(input, 'deleted', ServerLogColors.Remove);

const WEBHOOK_KEYS: Record<string, string> = {
  name: 'Name',
  channel_id: 'Channel',
  avatar_hash: 'Avatar',
  type: 'Type',
};

export const renderWebhookCreated = (input: RenderInput): RenderResult | null =>
  tail(input, {
    subject: 'Webhook',
    action: 'created',
    colour: ServerLogColors.Add,
    changeLabels: WEBHOOK_KEYS,
  });

export const renderWebhookUpdated = (input: RenderInput): RenderResult | null =>
  tail(input, {
    subject: 'Webhook',
    action: 'updated',
    colour: ServerLogColors.Modify,
    changeLabels: WEBHOOK_KEYS,
  });

export const renderWebhookDeleted = (input: RenderInput): RenderResult | null =>
  tail(input, { subject: 'Webhook', action: 'deleted', colour: ServerLogColors.Remove });

export const renderIntegrationCreated = (input: RenderInput): RenderResult | null =>
  tail(input, { subject: 'Integration', action: 'added', colour: ServerLogColors.Add });

export const renderIntegrationUpdated = (input: RenderInput): RenderResult | null =>
  tail(input, { subject: 'Integration', action: 'updated', colour: ServerLogColors.Modify });

export const renderIntegrationDeleted = (input: RenderInput): RenderResult | null =>
  tail(input, { subject: 'Integration', action: 'removed', colour: ServerLogColors.Remove });

function expression(subject: string, action: string, colour: number) {
  return (input: RenderInput): RenderResult | null =>
    tail(input, { subject, action, colour, changeLabels: { name: 'Name' } });
}

export const renderEmojiCreated = expression('Emoji', 'created', ServerLogColors.Add);
export const renderEmojiUpdated = expression('Emoji', 'renamed', ServerLogColors.Modify);
export const renderEmojiDeleted = expression('Emoji', 'deleted', ServerLogColors.Remove);

export const renderStickerCreated = expression('Sticker', 'created', ServerLogColors.Add);
export const renderStickerUpdated = expression('Sticker', 'updated', ServerLogColors.Modify);
export const renderStickerDeleted = expression('Sticker', 'deleted', ServerLogColors.Remove);

export const renderSoundboardCreated = expression('Soundboard sound', 'added', ServerLogColors.Add);
export const renderSoundboardUpdated = expression(
  'Soundboard sound',
  'updated',
  ServerLogColors.Modify,
);
export const renderSoundboardDeleted = expression(
  'Soundboard sound',
  'removed',
  ServerLogColors.Remove,
);

const SCHEDULED_KEYS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  channel_id: 'Channel',
  scheduled_start_time: 'Starts',
  scheduled_end_time: 'Ends',
  status: 'Status',
  entity_type: 'Kind',
  location: 'Location',
};

export const renderScheduledEventCreated = (input: RenderInput): RenderResult | null =>
  tail(input, {
    subject: 'Scheduled event',
    action: 'created',
    colour: ServerLogColors.Add,
    changeLabels: SCHEDULED_KEYS,
  });

export const renderScheduledEventUpdated = (input: RenderInput): RenderResult | null =>
  tail(input, {
    subject: 'Scheduled event',
    action: 'updated',
    colour: ServerLogColors.Modify,
    changeLabels: SCHEDULED_KEYS,
  });

export const renderScheduledEventDeleted = (input: RenderInput): RenderResult | null =>
  tail(input, { subject: 'Scheduled event', action: 'cancelled', colour: ServerLogColors.Remove });

const STAGE_KEYS: Record<string, string> = {
  topic: 'Topic',
  privacy_level: 'Privacy',
  channel_id: 'Channel',
};

export const renderStageStarted = (input: RenderInput): RenderResult | null =>
  tail(input, {
    subject: 'Stage',
    action: 'started',
    colour: ServerLogColors.Add,
    changeLabels: STAGE_KEYS,
  });

export const renderStageUpdated = (input: RenderInput): RenderResult | null =>
  tail(input, {
    subject: 'Stage',
    action: 'updated',
    colour: ServerLogColors.Modify,
    changeLabels: STAGE_KEYS,
  });

export const renderStageEnded = (input: RenderInput): RenderResult | null =>
  tail(input, { subject: 'Stage', action: 'ended', colour: ServerLogColors.Remove });

const AUTOMOD_KEYS: Record<string, string> = {
  name: 'Name',
  enabled: 'Enabled',
  trigger_type: 'Trigger',
  actions: 'Actions',
  exempt_roles: 'Exempt roles',
  exempt_channels: 'Exempt channels',
};

export const renderAutomodRuleCreated = (input: RenderInput): RenderResult | null =>
  tail(input, {
    subject: 'AutoMod rule',
    action: 'created',
    colour: ServerLogColors.Add,
    changeLabels: AUTOMOD_KEYS,
  });

export const renderAutomodRuleUpdated = (input: RenderInput): RenderResult | null =>
  tail(input, {
    subject: 'AutoMod rule',
    action: 'updated',
    colour: ServerLogColors.Modify,
    changeLabels: AUTOMOD_KEYS,
  });

export const renderAutomodRuleDeleted = (input: RenderInput): RenderResult | null =>
  tail(input, { subject: 'AutoMod rule', action: 'deleted', colour: ServerLogColors.Remove });

function automodAction(input: RenderInput, action: string, colour: number): RenderResult | null {
  const audit = input.audit;
  if (!audit) return null;

  const options = audit.options ?? {};
  const channelId = str(options.channel_id);

  return {
    embed: logEmbed({
      subject: 'AutoMod',
      action,
      colour,
      lines: [
        ...(audit.targetId
          ? [{ label: 'Member', mention: userMention(audit.targetId), value: audit.targetId }]
          : []),
        { label: 'Rule', value: str(options.auto_moderation_rule_name) ?? 'unknown' },
        ...(channelId
          ? [{ label: 'Channel', mention: channelMention(channelId), value: channelId }]
          : []),
        { label: 'Trigger', value: str(options.auto_moderation_rule_trigger_type) ?? 'unknown' },
      ],
      // AutoMod entries name the executor as the offending member, not a moderator. The footer
      // would otherwise read as though they had moderated themselves.
      executor: null,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export const renderAutomodBlocked = (input: RenderInput): RenderResult | null =>
  automodAction(input, 'blocked a message', ServerLogColors.Remove);

export const renderAutomodFlagged = (input: RenderInput): RenderResult | null =>
  automodAction(input, 'flagged a message', ServerLogColors.Modify);

export const renderAutomodTimedOut = (input: RenderInput): RenderResult | null =>
  automodAction(input, 'timed a member out', ServerLogColors.Modify);
