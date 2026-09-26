import {
  buildSnapshot,
  CHANNEL_TYPE_CATEGORY,
  type ChannelSnapshot,
  type GuildLayout,
  type GuildSnapshot,
  type RoleSnapshot,
  SNAPSHOT_VERSION,
} from './snapshot.ts';

export const RESTORE_SKIP_CODES = [
  'obfuscated_at_backup',

  'already_present',

  'managed_role',

  'everyone_role',
] as const;

export type RestoreSkipCode = (typeof RESTORE_SKIP_CODES)[number];

export interface RestoreSkip {
  kind: 'channel' | 'role';
  id: string;
  code: RestoreSkipCode;

  reason: string;
}

export type RestoreOp =
  | { op: 'create_role'; role: RoleSnapshot }
  | { op: 'create_channel'; channel: ChannelSnapshot };

export interface RestorePlan {
  guildId: string;
  backupId: string;

  dryRun: boolean;
  ops: RestoreOp[];
  skipped: RestoreSkip[];

  warnings: string[];
}

export interface RestoreRefusal {
  refusal: string;
}

export type RestoreResult = RestorePlan | RestoreRefusal;

export function isRestoreRefusal(value: RestoreResult): value is RestoreRefusal {
  return 'refusal' in value;
}

export interface RestoreInput {
  backupId: string;
  snapshot: GuildSnapshot;

  present: GuildLayout;
  dryRun: boolean;

  everyoneRoleId?: string;
}

// A restore is dry until the invoker says otherwise. It used to key on NODE_ENV, which made
// "does this change anything" a property of the deployment rather than of the command.
export function restoreIsDryRun(confirmed: boolean): boolean {
  return !confirmed;
}

export function planRestore(input: RestoreInput): RestoreResult {
  const { snapshot, present, backupId } = input;

  if (snapshot.schemaVersion !== SNAPSHOT_VERSION) {
    return {
      refusal:
        `That snapshot uses format version ${snapshot.schemaVersion}, and I can only read ` +
        `version ${SNAPSHOT_VERSION}. Restoring it would mean guessing what it holds, so I ` +
        'haven’t changed anything. Take a new backup instead.',
    };
  }

  if (snapshot.guildId !== present.guildId) {
    return {
      refusal:
        `That snapshot was taken in server ${snapshot.guildId}, not this one ` +
        `(${present.guildId}). Restoring it here would copy another server’s channels and roles ` +
        'into yours, so I stopped.',
    };
  }

  if (present.source === 'rest') {
    return {
      refusal:
        'I can’t plan this restore. My channel list for this server leaves out every channel ' +
        'I can’t see instead of marking it, so a hidden channel would look deleted and I’d ' +
        'recreate a copy next to it. Nothing was changed. This is a problem on my side, not a ' +
        'setting in this server.',
    };
  }

  const current = buildSnapshot(present, snapshot.capturedAt).snapshot;
  const presentChannelIds = new Set(current.channels.map((channel) => channel.id));
  const presentRoleIds = new Set(current.roles.map((role) => role.id));
  const everyoneRoleId = input.everyoneRoleId ?? snapshot.guildId;

  const skipped: RestoreSkip[] = [];
  const warnings: string[] = [];

  const rolesToCreate: RoleSnapshot[] = [];
  for (const role of snapshot.roles) {
    if (role.id === everyoneRoleId) {
      skipped.push({
        kind: 'role',
        id: role.id,
        code: 'everyone_role',
        reason: '@everyone is part of every server and can’t be recreated.',
      });
      continue;
    }

    if (presentRoleIds.has(role.id)) {
      skipped.push({
        kind: 'role',
        id: role.id,
        code: 'already_present',
        reason: `The role ${role.name} still exists.`,
      });
      continue;
    }

    if (role.managed) {
      skipped.push({
        kind: 'role',
        id: role.id,
        code: 'managed_role',
        reason:
          `${role.name} belongs to an app. Discord creates it again when the app is added back, ` +
          'and doesn’t let anyone else create it.',
      });
      continue;
    }

    rolesToCreate.push(role);
  }

  const channelsToCreate: ChannelSnapshot[] = [];
  for (const channel of snapshot.channels) {
    if (channel.obfuscated) {
      skipped.push({
        kind: 'channel',
        id: channel.id,
        code: 'obfuscated_at_backup',
        reason:
          'I couldn’t see this channel when the backup was taken (no View Channel permission), ' +
          'so the snapshot holds only its ID, type and position. There’s nothing to recreate it ' +
          'from.',
      });
      continue;
    }

    if (presentChannelIds.has(channel.id)) {
      skipped.push({
        kind: 'channel',
        id: channel.id,
        code: 'already_present',
        reason: `The channel ${channel.name ?? channel.id} still exists.`,
      });
      continue;
    }

    channelsToCreate.push(channel);
  }

  const creatableIds = new Set(channelsToCreate.map((channel) => channel.id));
  const orphaned: ChannelSnapshot[] = [];
  for (const channel of channelsToCreate) {
    if (!channel.parentId) continue;
    if (presentChannelIds.has(channel.parentId) || creatableIds.has(channel.parentId)) continue;
    orphaned.push(channel);
  }

  if (orphaned.length > 0) {
    warnings.push(
      `${orphaned.length} channel${orphaned.length === 1 ? '' : 's'} would be recreated outside ` +
        `${orphaned.length === 1 ? 'its' : 'their'} original category, because that category is ` +
        'gone and isn’t being restored (usually because I couldn’t see it): ' +
        `${orphaned.map((channel) => channel.name ?? channel.id).join(', ')}.`,
    );
  }

  const ops: RestoreOp[] = [
    ...sortByPosition(rolesToCreate).map((role): RestoreOp => ({ op: 'create_role', role })),

    ...sortChannels(channelsToCreate).map(
      (channel): RestoreOp => ({ op: 'create_channel', channel }),
    ),
  ];

  return { guildId: snapshot.guildId, backupId, dryRun: input.dryRun, ops, skipped, warnings };
}

function sortByPosition<T extends { position: number; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

function sortChannels(channels: readonly ChannelSnapshot[]): ChannelSnapshot[] {
  const categories = channels.filter((channel) => channel.type === CHANNEL_TYPE_CATEGORY);
  const rest = channels.filter((channel) => channel.type !== CHANNEL_TYPE_CATEGORY);
  return [...sortByPosition(categories), ...sortByPosition(rest)];
}

export function summariseRestore(plan: RestorePlan): { roles: number; channels: number } {
  return {
    roles: plan.ops.filter((op) => op.op === 'create_role').length,
    channels: plan.ops.filter((op) => op.op === 'create_channel').length,
  };
}

const MAX_LISTED = 8;

function skipLine(skip: RestoreSkip): string {
  const mention = skip.kind === 'channel' ? `<#${skip.id}>` : `<@&${skip.id}>`;
  return `- ${mention}: ${skip.reason}`;
}

function skipLines(skips: readonly RestoreSkip[]): string[] {
  const lines = skips.slice(0, MAX_LISTED).map(skipLine);
  const rest = skips.length - lines.length;
  return rest > 0 ? [...lines, `- …and ${rest} more.`] : lines;
}

export function describeRestore(plan: RestorePlan): string[] {
  const counts = summariseRestore(plan);
  const lines = [
    `Restore plan for backup \`${plan.backupId}\`: recreate ${counts.roles} ` +
      `role${counts.roles === 1 ? '' : 's'} and ${counts.channels} ` +
      `channel${counts.channels === 1 ? '' : 's'}. A restore never deletes anything, so ` +
      'whatever was created since the backup stays.',
  ];

  const obfuscated = plan.skipped.filter((skip) => skip.code === 'obfuscated_at_backup');
  if (obfuscated.length > 0) {
    lines.push(
      `${obfuscated.length} channel${obfuscated.length === 1 ? '' : 's'} in this backup ` +
        'can’t be restored:',
      ...skipLines(obfuscated),
      'Give me the View Channel permission in those channels and take a new backup. A snapshot ' +
        'taken without it has nothing to restore from.',
    );
  }

  const other = plan.skipped.filter((skip) => skip.code !== 'obfuscated_at_backup');
  if (other.length > 0) {
    lines.push(`Also skipped (${other.length}):`, ...skipLines(other));
  }

  lines.push(...plan.warnings);

  if (plan.dryRun && counts.roles + counts.channels > 0) {
    lines.push(
      'Recreated channels won’t get their old permissions back, and members won’t get ' +
        'recreated roles back.',
    );
  }

  if (plan.dryRun) lines.push('This is a preview. Nothing was changed.');

  return lines;
}
