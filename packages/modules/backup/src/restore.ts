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
  /** The bot could not see the channel when the backup was taken (§10.1). */
  'obfuscated_at_backup',
  /** It still exists, so recreating it would duplicate it. */
  'already_present',
  /** Owned by an integration; Discord refuses to create these. */
  'managed_role',
  /** @everyone exists in every guild and cannot be created. */
  'everyone_role',
] as const;

export type RestoreSkipCode = (typeof RESTORE_SKIP_CODES)[number];

export interface RestoreSkip {
  kind: 'channel' | 'role';
  id: string;
  code: RestoreSkipCode;
  /** Written for the admin reading the report, not for a log grep. */
  reason: string;
}

/**
 * One step of a restore.
 *
 * The ids inside are **snapshot** ids: the channel and role ids the guild had
 * when the backup was taken. Discord assigns new ids to everything it creates,
 * so whatever applies this plan has to keep an old-id → new-id map and translate
 * `parentId` and every overwrite `id` through it as it goes. That translation is
 * the difference between a restored server and a server full of channels whose
 * permissions point at roles that no longer exist — and it belongs to the
 * applier, because only the applier learns the new ids.
 */
export type RestoreOp =
  | { op: 'create_role'; role: RoleSnapshot }
  | { op: 'create_channel'; channel: ChannelSnapshot };

export interface RestorePlan {
  guildId: string;
  backupId: string;
  /** I12: outside production a restore is planned and reported, never performed. */
  dryRun: boolean;
  ops: RestoreOp[];
  skipped: RestoreSkip[];
  /** Consequences of the skips that an admin has to decide about. */
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
  /** The guild as it is right now — the same raw shape a snapshot is built from. */
  present: GuildLayout;
  dryRun: boolean;
  /** Discord's @everyone role id equals the guild id. */
  everyoneRoleId?: string;
}

/**
 * I12 lists restore among the destructive actions that default to dry run
 * outside production. There is no `ActionKind` for "create a channel", so
 * `isDestructive` cannot answer this one and the rule is applied here instead.
 */
export function restoreIsDryRun(env: string | undefined = process.env.NODE_ENV): boolean {
  return env !== 'production';
}

/**
 * Work out what a restore would do, and what it would refuse to do.
 *
 * The comparison is snapshot-to-snapshot: the current guild is run through the
 * same `buildSnapshot` the backup came from, so both sides were parsed by one
 * reader and a difference between them is a real difference rather than two
 * parsers disagreeing.
 *
 * Nothing here deletes. A restore after a nuke has to be additive: the attacker
 * removed things, and removing more — channels created since the backup, a role
 * added yesterday — turns a partial loss into a total one. §15's framing is that
 * the product's value is restore *quality*, and quality here means never
 * destroying something the backup simply does not know about.
 */
export function planRestore(input: RestoreInput): RestoreResult {
  const { snapshot, present, backupId } = input;

  if (snapshot.schemaVersion !== SNAPSHOT_VERSION) {
    return {
      refusal:
        `That snapshot is in format version ${snapshot.schemaVersion} and this build of Proton ` +
        `reads version ${SNAPSHOT_VERSION}. Restoring it would mean guessing what its fields ` +
        'mean, so Proton will not touch the server. Upgrade Proton, or take a fresh backup.',
    };
  }

  if (snapshot.guildId !== present.guildId) {
    return {
      refusal:
        `That snapshot was taken in server ${snapshot.guildId}, not this one ` +
        `(${present.guildId}). Restoring another server's layout here would create its channels ` +
        'and roles in your server, so Proton refuses.',
    };
  }

  // The one refusal §10.1 makes unavoidable. A REST channel list omits hidden
  // channels rather than marking them, so every hidden channel would look
  // "missing" and be recreated alongside the one that already exists — a restore
  // that doubles the server. Detecting that after the fact is impossible; the
  // duplicates are indistinguishable from channels the admin wanted.
  if (present.source === 'rest') {
    return {
      refusal:
        'Proton will not plan a restore from Discord’s REST channel list: it omits channels the ' +
        'bot cannot view instead of marking them, so every hidden channel would look missing and ' +
        'be recreated next to the one that already exists. The gateway’s view of the server is ' +
        'the only one that can see them. This is a Proton deployment problem — whoever runs the ' +
        'bot needs to bind readLayout to the gateway-derived guild layout.',
    };
  }

  // Same parser both sides, so "present" means exactly what "captured" meant.
  // Only ids and shapes are read from it; the clock it is handed is irrelevant.
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
        reason: '@everyone exists in every server and cannot be created.',
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
          `${role.name} belongs to an app or integration. Discord creates those roles itself ` +
          'when the app is added back, and refuses to let anyone else create them.',
      });
      continue;
    }

    rolesToCreate.push(role);
  }

  const channelsToCreate: ChannelSnapshot[] = [];
  for (const channel of snapshot.channels) {
    if (channel.obfuscated) {
      // The headline of §10.1 and of Gate 2: skip, and say so. Recreating from a
      // placeholder would produce a channel with no name, no topic and no
      // permissions sitting where a private channel used to be — worse than the
      // hole it filled, because it looks restored.
      skipped.push({
        kind: 'channel',
        id: channel.id,
        code: 'obfuscated_at_backup',
        reason:
          'Proton could not see this channel when the backup was taken (no View Channel ' +
          'permission), so the snapshot holds only its id, type and position. There is nothing ' +
          'to recreate it from.',
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

  // A category that was hidden at backup time is skipped, which orphans every
  // child that lived under it. Creating the child at the top level anyway is the
  // right call — the messages have somewhere to go — but it is a visible change
  // to the server's shape, so it is named rather than absorbed.
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
        'gone and is not being restored (usually because Proton could not see it): ' +
        `${orphaned.map((channel) => channel.name ?? channel.id).join(', ')}.`,
    );
  }

  const ops: RestoreOp[] = [
    // Roles first: a channel's permission overwrites name roles, so the roles
    // have to exist before the overwrites can point at them. Ascending position
    // keeps the order deterministic and rebuilds the hierarchy bottom-up.
    ...sortByPosition(rolesToCreate).map((role): RestoreOp => ({ op: 'create_role', role })),
    // Then categories, then everything else — Discord rejects a channel whose
    // `parent_id` does not exist yet.
    ...sortChannels(channelsToCreate).map(
      (channel): RestoreOp => ({ op: 'create_channel', channel }),
    ),
  ];

  return { guildId: snapshot.guildId, backupId, dryRun: input.dryRun, ops, skipped, warnings };
}

function sortByPosition<T extends { position: number; id: string }>(items: readonly T[]): T[] {
  // Id breaks ties, so two roles at the same position never swap between runs.
  return [...items].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

function sortChannels(channels: readonly ChannelSnapshot[]): ChannelSnapshot[] {
  const categories = channels.filter((channel) => channel.type === CHANNEL_TYPE_CATEGORY);
  const rest = channels.filter((channel) => channel.type !== CHANNEL_TYPE_CATEGORY);
  return [...sortByPosition(categories), ...sortByPosition(rest)];
}

/** How many of each thing a plan would create — the headline of the report. */
export function summariseRestore(plan: RestorePlan): { roles: number; channels: number } {
  return {
    roles: plan.ops.filter((op) => op.op === 'create_role').length,
    channels: plan.ops.filter((op) => op.op === 'create_channel').length,
  };
}

/** Discord caps a message at 2000 characters; a 40-line skip list would not fit. */
const MAX_LISTED = 8;

function skipLine(skip: RestoreSkip): string {
  const mention = skip.kind === 'channel' ? `<#${skip.id}>` : `<@&${skip.id}>`;
  return `- ${mention} — ${skip.reason}`;
}

function skipLines(skips: readonly RestoreSkip[]): string[] {
  const lines = skips.slice(0, MAX_LISTED).map(skipLine);
  const rest = skips.length - lines.length;
  return rest > 0 ? [...lines, `- …and ${rest} more.`] : lines;
}

/**
 * The report §12's Gate 2 asks for: what a restore would do, and every channel
 * it would leave alone, with the reason attached to each one.
 */
export function describeRestore(plan: RestorePlan): string[] {
  const counts = summariseRestore(plan);
  const lines = [
    `Restore plan for backup ${plan.backupId}: recreate ${counts.roles} ` +
      `role${counts.roles === 1 ? '' : 's'} and ${counts.channels} ` +
      `channel${counts.channels === 1 ? '' : 's'}. Nothing is ever deleted by a restore — ` +
      'anything created since the backup stays.',
  ];

  const obfuscated = plan.skipped.filter((skip) => skip.code === 'obfuscated_at_backup');
  if (obfuscated.length > 0) {
    lines.push(
      `${obfuscated.length} channel${obfuscated.length === 1 ? '' : 's'} in this backup ` +
        `cannot be restored and ${obfuscated.length === 1 ? 'is' : 'are'} being skipped:`,
      ...skipLines(obfuscated),
      'Grant Proton the View Channel permission in those channels and take a new backup; a ' +
        'snapshot taken without it holds nothing to restore from.',
    );
  }

  const other = plan.skipped.filter((skip) => skip.code !== 'obfuscated_at_backup');
  if (other.length > 0) {
    lines.push(`Also skipped (${other.length}):`, ...skipLines(other));
  }

  lines.push(...plan.warnings);

  if (plan.dryRun) {
    lines.push(
      `This is a preview. Nothing was changed (NODE_ENV is '${process.env.NODE_ENV ?? 'unset'}', ` +
        'not production, and Proton refuses destructive actions outside production).',
    );
  }

  return lines;
}
