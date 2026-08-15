import { parseOverwrites, snowflakeSchema } from '@proton/core';
import { isObfuscatedChannel } from '@proton/gateway/normaliser';
import { z } from 'zod';

/**
 * Snapshot format version, written to `backups.version` (§6).
 *
 * Separate from the module's `schema_version`, which versions the *config*. A
 * snapshot outlives the config that produced it: a restore run next year reads a
 * document this build wrote, so the reader has to know which shape it is holding
 * before it can trust a single field.
 */
export const SNAPSHOT_VERSION = 1;

/**
 * Where a channel/role list came from, and therefore what it is allowed to be
 * trusted for.
 *
 * §10.1: from 16 Nov 2026 `GET /guilds/{id}/channels` **omits** channels the bot
 * cannot VIEW_CHANNEL, while the gateway still delivers them carrying the
 * `CHANNEL_OBFUSCATED` flag. So the two sources disagree in the one way that
 * matters here: the REST list cannot even count what is missing from it, and a
 * backup taken from it would be silently partial — which is worse than no backup,
 * because a backup is trusted. Recording the provenance is what lets this module
 * say "N channels are hidden" instead of "0 channels are hidden".
 */
export const LAYOUT_SOURCES = ['gateway', 'rest'] as const;
export type LayoutSource = (typeof LAYOUT_SOURCES)[number];

/** Discord's category channel type — parents, which must exist before children. */
export const CHANNEL_TYPE_CATEGORY = 4;

const bitfieldSchema = z.string().regex(/^\d+$/, 'must be a decimal permission bitfield');

export const overwriteSnapshotSchema = z.object({
  id: snowflakeSchema,
  /** 0 = role, 1 = member, exactly as Discord numbers them. */
  type: z.union([z.literal(0), z.literal(1)]),
  /**
   * Kept as decimal strings, never numbers. Permission bitfields exceed 2^53 —
   * `PIN_MESSAGES` alone is 1<<51 (§10.3) — and JSON has no bigint, so a jsonb
   * column holding these as numbers would silently round a server's permissions.
   */
  allow: bitfieldSchema,
  deny: bitfieldSchema,
});

export type OverwriteSnapshot = z.infer<typeof overwriteSnapshotSchema>;

/**
 * One channel as it was at snapshot time.
 *
 * `id`, `type`, `position` and `parentId` are non-null even when obfuscated:
 * Discord never obfuscates those four. Everything else is nullable because for a
 * hidden channel there is nothing truthful to put there — see `captureChannel`.
 */
export const channelSnapshotSchema = z.object({
  id: snowflakeSchema,
  type: z.number().int(),
  position: z.number().int(),
  parentId: snowflakeSchema.nullable(),
  /** The bot could not VIEW_CHANNEL this channel when the snapshot was taken. */
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
  /**
   * Owned by an integration — a bot's own role, a Twitch subscriber role, the
   * booster role. Discord refuses to create these, so a restore must skip them
   * rather than fail halfway through (see `planRestore`).
   */
  managed: z.boolean(),
});

export type RoleSnapshot = z.infer<typeof roleSnapshotSchema>;

/**
 * What goes in `backups.snapshot` (§6).
 *
 * Validated on every write **and** every read (I5's rule, applied to the module's
 * own document rather than to its config): the column is jsonb written by a
 * possibly older build, so a snapshot read back is a claim about a snapshot, not
 * one of ours.
 */
export const guildSnapshotSchema = z.object({
  schemaVersion: z.number().int().positive(),
  guildId: snowflakeSchema,
  capturedAt: z.number().int().nonnegative(),
  source: z.enum(LAYOUT_SOURCES),
  channels: z.array(channelSnapshotSchema),
  roles: z.array(roleSnapshotSchema),
});

export type GuildSnapshot = z.infer<typeof guildSnapshotSchema>;

/**
 * The guild's channels and roles as some source reported them.
 *
 * `unknown[]` because these are raw Discord objects and this module does not get
 * to assume their shape — the normaliser owns that translation for events, and
 * for a full layout there is no normalised form yet. Parsed defensively below.
 */
export interface GuildLayout {
  guildId: string;
  source: LayoutSource;
  channels: readonly unknown[];
  roles: readonly unknown[];
}

/**
 * What an admin is told the moment a backup is taken.
 *
 * §10.1 requires the "these N channels can't be backed up" message to reach a
 * human *at backup time*. Reporting it at restore time instead means the server
 * has already been nuked before anyone learns the backup was incomplete.
 */
export interface CaptureReport {
  guildId: string;
  source: LayoutSource;
  capturedAt: number;
  channelsCaptured: number;
  /** Present in the snapshot as placeholders, but with no contents. */
  obfuscatedChannelIds: string[];
  rolesCaptured: number;
  /**
   * Objects Discord sent in a shape this build could not read.
   *
   * Counted rather than dropped, for the same reason obfuscated channels are
   * marked rather than omitted: anything missing from a backup has to be visible
   * in the backup.
   */
  unreadable: number;
}

/** Lenient view of a raw Discord channel — only the fields a restore needs. */
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

/**
 * Reuses core's overwrite parser rather than reading `allow`/`deny` directly.
 *
 * That parser is the one place that knows Discord sends permissions as decimal
 * strings and turns them into bigint; a second reader here would be a second
 * chance to treat them as numbers. Back to strings on the way out, because the
 * snapshot is JSON.
 */
function captureOverwrites(raw: unknown): OverwriteSnapshot[] {
  return parseOverwrites(raw).map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: String(overwrite.allow),
    deny: String(overwrite.deny),
  }));
}

/**
 * Turn one raw channel into a snapshot entry.
 *
 * An obfuscated channel keeps **only** the four fields Discord guarantees are
 * never obfuscated. In particular its permission overwrites are dropped even
 * though the dispatch carries some: Discord nulls the sensitive fields of a
 * hidden channel, so what arrives cannot be assumed complete, and restoring a
 * partial overwrite set would quietly rewrite that channel's permissions — plan
 * risk R4, arrived at from the other direction. A placeholder that says "I could
 * not read this" is recoverable; a channel restored with half its permissions is
 * not, because nobody will know to look.
 */
export function captureChannel(raw: z.infer<typeof rawChannelSchema>): ChannelSnapshot {
  const base = {
    id: raw.id,
    type: raw.type,
    position: raw.position,
    parentId: raw.parent_id ?? null,
  };

  // By flag, never by name. A guild is entitled to call a real channel
  // `___hidden___`, and matching the string would hide a channel the bot can
  // actually see — Discord's docs say so outright, and `isObfuscatedChannel` is
  // imported rather than reimplemented so there is exactly one definition of the
  // bit to get wrong.
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

/**
 * Build the document that goes in `backups.snapshot`, plus the report a human
 * reads immediately afterwards.
 *
 * Deterministic and side-effect free: same layout in, same snapshot out. That is
 * what makes the round-trip test meaningful, and it is why the clock is an
 * argument.
 */
export function buildSnapshot(layout: GuildLayout, capturedAt: number): CaptureResult {
  const channels: ChannelSnapshot[] = [];
  const roles: RoleSnapshot[] = [];
  const obfuscatedChannelIds: string[] = [];
  let unreadable = 0;

  // Validated one at a time rather than once at the end, so a single object
  // Discord sends in an unexpected shape — an id that is not a snowflake, say —
  // costs that one entry and is counted, instead of throwing out of the whole
  // backup. A backup that fails entirely because of one odd channel is a backup
  // the guild does not have.
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

/** Re-derive the report from a stored snapshot, for listings and restore. */
export function coverageOf(snapshot: GuildSnapshot): CaptureReport {
  const obfuscatedChannelIds = snapshot.channels.filter((c) => c.obfuscated).map((c) => c.id);

  return {
    guildId: snapshot.guildId,
    source: snapshot.source,
    capturedAt: snapshot.capturedAt,
    channelsCaptured: snapshot.channels.length - obfuscatedChannelIds.length,
    obfuscatedChannelIds,
    rolesCaptured: snapshot.roles.length,
    // Not recoverable from the document: an object that could not be read left
    // nothing behind to count. The report at capture time is the only place it
    // was ever visible, which is the other half of why that report matters.
    unreadable: 0,
  };
}

function channelList(ids: readonly string[], limit = 10): string {
  const shown = ids.slice(0, limit).map((id) => `<#${id}>`);
  const rest = ids.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/**
 * The sentences an admin gets back from `/backup create`.
 *
 * Names the permission and where to grant it (§1: "the bot did nothing" is a
 * bug), and says what the gap will mean later, at restore, while there is still
 * time to close it.
 */
export function describeCapture(report: CaptureReport): string[] {
  const lines = [
    `Backed up ${report.channelsCaptured} channel${report.channelsCaptured === 1 ? '' : 's'} ` +
      `and ${report.rolesCaptured} role${report.rolesCaptured === 1 ? '' : 's'}.`,
  ];

  if (report.obfuscatedChannelIds.length > 0) {
    const n = report.obfuscatedChannelIds.length;
    lines.push(
      `${n} channel${n === 1 ? '' : 's'} could NOT be backed up: ${channelList(
        report.obfuscatedChannelIds,
      )}. Proton has no View Channel permission there, and Discord hides the name, topic and ` +
        'permissions of a channel a bot cannot view — so there is nothing to save. Grant View ' +
        'Channel to Proton in each of those channels (Channel Settings → Permissions), then run ' +
        '`/backup create` again. Until then a restore from this snapshot will leave ' +
        `${n === 1 ? 'that channel' : 'those channels'} untouched rather than recreate ` +
        `${n === 1 ? 'it' : 'them'} wrongly.`,
    );
  }

  if (report.source === 'rest') {
    lines.push(
      'Warning: this snapshot was taken from Discord’s REST channel list, which omits hidden ' +
        'channels entirely rather than marking them. The count above may therefore be missing ' +
        'channels nobody can see are missing. Treat it as incomplete.',
    );
  }

  if (report.unreadable > 0) {
    lines.push(
      `${report.unreadable} object${report.unreadable === 1 ? '' : 's'} Discord sent could not ` +
        'be read by this version of Proton and ' +
        `${report.unreadable === 1 ? 'is' : 'are'} not in the snapshot. This is a Proton bug, ` +
        'not a permission problem — please report it.',
    );
  }

  return lines;
}
