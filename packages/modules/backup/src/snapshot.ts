import { labelOf, type ModuleContext, parseOverwrites, snowflakeSchema } from '@proton/core';
import { isObfuscatedChannel } from '@proton/gateway/normaliser';
import { z } from 'zod';

export const SNAPSHOT_VERSION = 1;

export const LAYOUT_SOURCES = ['gateway', 'rest'] as const;
export type LayoutSource = (typeof LAYOUT_SOURCES)[number];

export const CHANNEL_TYPE_CATEGORY = 4;

const bitfieldSchema = z.string().regex(/^\d+$/, 'must be a decimal permission bitfield');

export const overwriteSnapshotSchema = z.object({
  id: snowflakeSchema,

  type: z.union([z.literal(0), z.literal(1)]),

  allow: bitfieldSchema,
  deny: bitfieldSchema,
});

export type OverwriteSnapshot = z.infer<typeof overwriteSnapshotSchema>;

export const channelSnapshotSchema = z.object({
  id: snowflakeSchema,
  type: z.number().int(),
  position: z.number().int(),
  parentId: snowflakeSchema.nullable(),

  obfuscated: z.boolean(),
  name: z.string().nullable(),
  topic: z.string().nullable(),
  nsfw: z.boolean().nullable(),
  rateLimitPerUser: z.number().int().nullable(),
  bitrate: z.number().int().nullable(),
  userLimit: z.number().int().nullable(),
  overwrites: z.array(overwriteSnapshotSchema),
});

export type ChannelSnapshot = z.infer<typeof channelSnapshotSchema>;

export const roleSnapshotSchema = z.object({
  id: snowflakeSchema,
  name: z.string(),
  permissions: bitfieldSchema,
  position: z.number().int(),
  color: z.number().int(),
  hoist: z.boolean(),
  mentionable: z.boolean(),

  managed: z.boolean(),
});

export type RoleSnapshot = z.infer<typeof roleSnapshotSchema>;

export const guildSnapshotSchema = z.object({
  schemaVersion: z.number().int().positive(),
  guildId: snowflakeSchema,
  capturedAt: z.number().int().nonnegative(),
  source: z.enum(LAYOUT_SOURCES),
  channels: z.array(channelSnapshotSchema),
  roles: z.array(roleSnapshotSchema),
});

export type GuildSnapshot = z.infer<typeof guildSnapshotSchema>;

export interface GuildLayout {
  guildId: string;
  source: LayoutSource;
  channels: readonly unknown[];
  roles: readonly unknown[];
}

export interface CaptureReport {
  guildId: string;
  source: LayoutSource;
  capturedAt: number;
  channelsCaptured: number;

  obfuscatedChannelIds: string[];
  rolesCaptured: number;

  unreadable: number;
}

const rawChannelSchema = z.object({
  id: z.string().min(1),
  type: z.number().int().catch(0),
  name: z.string().nullish(),
  topic: z.string().nullish(),
  position: z.number().int().catch(0),
  parent_id: z.string().nullish(),
  nsfw: z.boolean().nullish(),
  rate_limit_per_user: z.number().int().nullish(),
  bitrate: z.number().int().nullish(),
  user_limit: z.number().int().nullish(),
  flags: z.number().int().catch(0),
  permission_overwrites: z.unknown().optional(),
});

const rawRoleSchema = z.object({
  id: z.string().min(1),
  name: z.string().catch(''),
  permissions: z.string().catch('0'),
  position: z.number().int().catch(0),
  color: z.number().int().catch(0),
  hoist: z.boolean().catch(false),
  mentionable: z.boolean().catch(false),
  managed: z.boolean().catch(false),
});

function captureOverwrites(raw: unknown): OverwriteSnapshot[] {
  return parseOverwrites(raw).map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: String(overwrite.allow),
    deny: String(overwrite.deny),
  }));
}

export function captureChannel(raw: z.infer<typeof rawChannelSchema>): ChannelSnapshot {
  const base = {
    id: raw.id,
    type: raw.type,
    position: raw.position,
    parentId: raw.parent_id ?? null,
  };

  if (isObfuscatedChannel(raw)) {
    return {
      ...base,
      obfuscated: true,
      name: null,
      topic: null,
      nsfw: null,
      rateLimitPerUser: null,
      bitrate: null,
      userLimit: null,
      overwrites: [],
    };
  }

  return {
    ...base,
    obfuscated: false,
    name: raw.name ?? null,
    topic: raw.topic ?? null,
    nsfw: raw.nsfw ?? null,
    rateLimitPerUser: raw.rate_limit_per_user ?? null,
    bitrate: raw.bitrate ?? null,
    userLimit: raw.user_limit ?? null,
    overwrites: captureOverwrites(raw.permission_overwrites),
  };
}

export interface CaptureResult {
  snapshot: GuildSnapshot;
  report: CaptureReport;
}

export function buildSnapshot(layout: GuildLayout, capturedAt: number): CaptureResult {
  const channels: ChannelSnapshot[] = [];
  const roles: RoleSnapshot[] = [];
  const obfuscatedChannelIds: string[] = [];
  let unreadable = 0;

  for (const raw of layout.channels) {
    const parsed = rawChannelSchema.safeParse(raw);
    const channel = parsed.success
      ? channelSnapshotSchema.safeParse(captureChannel(parsed.data))
      : null;

    if (!channel?.success) {
      unreadable++;
      continue;
    }

    if (channel.data.obfuscated) obfuscatedChannelIds.push(channel.data.id);
    channels.push(channel.data);
  }

  for (const raw of layout.roles) {
    const parsed = rawRoleSchema.safeParse(raw);
    const role = parsed.success
      ? roleSnapshotSchema.safeParse({
          id: parsed.data.id,
          name: parsed.data.name,
          permissions: parsed.data.permissions,
          position: parsed.data.position,
          color: parsed.data.color,
          hoist: parsed.data.hoist,
          mentionable: parsed.data.mentionable,
          managed: parsed.data.managed,
        })
      : null;

    if (!role?.success) {
      unreadable++;
      continue;
    }

    roles.push(role.data);
  }

  const snapshot = guildSnapshotSchema.parse({
    schemaVersion: SNAPSHOT_VERSION,
    guildId: layout.guildId,
    capturedAt,
    source: layout.source,
    channels,
    roles,
  });

  return {
    snapshot,
    report: {
      guildId: snapshot.guildId,
      source: snapshot.source,
      capturedAt,
      channelsCaptured: channels.length - obfuscatedChannelIds.length,
      obfuscatedChannelIds,
      rolesCaptured: roles.length,
      unreadable,
    },
  };
}

export function coverageOf(snapshot: GuildSnapshot): CaptureReport {
  const obfuscatedChannelIds = snapshot.channels.filter((c) => c.obfuscated).map((c) => c.id);

  return {
    guildId: snapshot.guildId,
    source: snapshot.source,
    capturedAt: snapshot.capturedAt,
    channelsCaptured: snapshot.channels.length - obfuscatedChannelIds.length,
    obfuscatedChannelIds,
    rolesCaptured: snapshot.roles.length,

    unreadable: 0,
  };
}

function channelList(ids: readonly string[], limit = 10): string {
  const shown = ids.slice(0, limit).map((id) => `<#${id}>`);
  const rest = ids.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

export function describeCapture(
  report: CaptureReport,
  labels: Pick<ModuleContext, 'commandLabel'> = {},
): string[] {
  const lines = [
    `Backed up ${report.channelsCaptured} channel${report.channelsCaptured === 1 ? '' : 's'} ` +
      `and ${report.rolesCaptured} role${report.rolesCaptured === 1 ? '' : 's'}.`,
  ];

  if (report.obfuscatedChannelIds.length > 0) {
    const n = report.obfuscatedChannelIds.length;
    lines.push(
      `**${n} channel${n === 1 ? '' : 's'} couldn’t be backed up:** ${channelList(
        report.obfuscatedChannelIds,
      )}. I don’t have View Channel there, and Discord hides the name, topic and permissions ` +
        'of channels I can’t view, so there’s nothing to save. Give me the View Channel ' +
        'permission in each of those channels (Channel Settings → Permissions), then run ' +
        `\`${labelOf(labels, 'backup', 'create')}\` again. Until then, restoring this snapshot ` +
        `leaves ${n === 1 ? 'that channel' : 'those channels'} untouched instead of recreating ` +
        `${n === 1 ? 'it' : 'them'} wrongly.`,
    );
  }

  if (report.source === 'rest') {
    lines.push(
      'This snapshot may be missing channels. The channel list it came from leaves out hidden ' +
        'channels instead of marking them, so there’s no way to tell which are missing. Treat ' +
        'it as incomplete.',
    );
  }

  if (report.unreadable > 0) {
    lines.push(
      `I couldn’t read ${report.unreadable} item${report.unreadable === 1 ? '' : 's'} Discord ` +
        `sent, so ${report.unreadable === 1 ? 'it isn’t' : 'they aren’t'} in the snapshot. ` +
        'This is a bug on my side, not a permission problem. Please report it.',
    );
  }

  return lines;
}
