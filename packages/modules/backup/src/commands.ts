import { type CommandContext, type CommandDefinition, Permissions } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { BackupConfig } from './config.ts';
import { type BackupDeps, type BoundBackupDeps, bindDeps, describeUnbound } from './deps.ts';
import {
  describeRestore,
  isRestoreRefusal,
  planRestore,
  restoreIsDryRun,
  summariseRestore,
} from './restore.ts';
import { buildSnapshot, coverageOf, describeCapture, SNAPSHOT_VERSION } from './snapshot.ts';
import type { BackupRecord } from './store.ts';

export const MODULE_ID = 'backup';

/** Discord rejects a message body over 2000 characters outright. */
const CONTENT_MAX = 2000;

const DISABLED =
  'Backups are switched off in this server. An admin can turn the Backup module back on from ' +
  'the Proton dashboard.';

const NO_LAYOUT =
  'Proton does not have this server’s channel and role list yet, so there is nothing to snapshot. ' +
  'That list arrives when the gateway connects to the server — try again in a moment. Nothing ' +
  'has been saved.';

/**
 * The honest answer to "why did nothing happen".
 *
 * Every step of the restore is worked out and shown; what is missing is the last
 * one. Creating a channel or a role is not among the actions the ActionExecutor
 * can perform, and I1/I2 forbid a module from reaching Discord around it, so
 * this command is a preview until core grows those kinds. Saying so beats a
 * command that appears to restore and does not.
 */
const CANNOT_APPLY =
  'Proton cannot carry this plan out yet: creating a channel or a role is not something its ' +
  'action layer can do, and a module is never allowed to call Discord directly around it. So ' +
  '`/backup restore` shows you exactly what a restore would do and changes nothing. When it can ' +
  'act, it will need the Manage Channels and Manage Roles permissions in this server.';

/**
 * `/backup` — snapshot the server's structure, and preview putting it back.
 *
 * Gated on Manage Server rather than Administrator. Everything the command can
 * do — read the channel list, recreate channels and roles — is already available
 * to a Manage Server holder in Discord's own UI, and requiring Administrator
 * would push servers into handing Administrator to whoever runs backups.
 */
export function createBackupCommands(deps: BackupDeps): CommandDefinition<BackupConfig>[] {
  return [
    {
      name: 'backup',
      description: 'Snapshot this server’s channels and roles, or preview restoring one.',

      data: new SlashCommandBuilder()
        .setName('backup')
        .setDescription('Snapshot this server’s channels and roles, or preview restoring one.')
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(Permissions.ManageGuild)
        .addSubcommand((sub) =>
          sub
            .setName('create')
            .setDescription('Take a snapshot of every channel, role and permission overwrite.'),
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Show the snapshots this server has kept.'),
        )
        .addSubcommand((sub) =>
          sub
            .setName('restore')
            .setDescription('Show what restoring a snapshot would do. Nothing is changed.')
            .addStringOption((option) =>
              option
                .setName('backup_id')
                .setDescription('The id from /backup list.')
                .setRequired(true)
                .setMaxLength(64),
            ),
        )
        .toJSON(),

      async handler(ctx) {
        switch (ctx.options.getSubcommand()) {
          case 'list':
            return list(ctx, deps);
          case 'restore':
            return restore(ctx, deps);
          default:
            return create(ctx, deps);
        }
      },
    },
  ];
}

/** Resolve the ports, telling the admin precisely what is missing if any are. */
async function bound(
  ctx: CommandContext<BackupConfig>,
  deps: BackupDeps,
): Promise<BoundBackupDeps | null> {
  if (!ctx.config.enabled) {
    await reply(ctx, [DISABLED]);
    return null;
  }

  const result = bindDeps(deps);
  if ('unbound' in result) {
    const message = describeUnbound(result.unbound);
    ctx.logger.error(message, { guildId: ctx.guildId, moduleId: MODULE_ID });
    await reply(ctx, [message]);
    return null;
  }

  return result.deps;
}

async function create(ctx: CommandContext<BackupConfig>, deps: BackupDeps): Promise<void> {
  const ports = await bound(ctx, deps);
  if (!ports) return;

  const layout = await ports.readLayout(ctx.guildId);
  if (!layout) return reply(ctx, [NO_LAYOUT]);

  // A wiring bug that handed us another server's layout would otherwise be
  // written into this server's row and restored into it later.
  if (layout.guildId !== ctx.guildId) {
    const message =
      `Proton read the structure of server ${layout.guildId} while backing up ${ctx.guildId}, ` +
      'which is a bug in this deployment. Nothing has been saved.';
    ctx.logger.error(message, { guildId: ctx.guildId, moduleId: MODULE_ID });
    return reply(ctx, [message]);
  }

  const capturedAt = ports.now();
  const { snapshot, report } = buildSnapshot(layout, capturedAt);
  const backupId = ports.newBackupId();

  try {
    await ports.store.save({
      id: backupId,
      guildId: ctx.guildId,
      version: SNAPSHOT_VERSION,
      createdBy: ctx.userId,
      createdAt: new Date(capturedAt),
      snapshot,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.logger.error(`backup ${backupId} could not be saved: ${detail}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return reply(ctx, [
      'The snapshot could not be saved, so this server has NO new backup. Proton’s database ' +
        `refused the write: ${detail}`,
    ]);
  }

  const lines = [`Backup \`${backupId}\` saved.`, ...describeCapture(report)];

  if (report.obfuscatedChannelIds.length > 0) {
    // Also to the log, not only to the ephemeral reply. The reply is seen once
    // by one person; whoever reads the logs a month later needs to know this
    // server's backups have holes in them.
    ctx.logger.warn(
      `backup ${backupId} could not capture ${report.obfuscatedChannelIds.length} channel(s) ` +
        `in guild ${ctx.guildId} — no VIEW_CHANNEL: ${report.obfuscatedChannelIds.join(', ')}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }

  const pruned = await ports.store.prune(ctx.guildId, ctx.config.retainBackups);
  if (pruned > 0) {
    lines.push(
      `Deleted ${pruned} older snapshot${pruned === 1 ? '' : 's'} to stay within the ` +
        `${ctx.config.retainBackups} this server keeps.`,
    );
  }

  await reply(ctx, lines);
}

async function list(ctx: CommandContext<BackupConfig>, deps: BackupDeps): Promise<void> {
  const ports = await bound(ctx, deps);
  if (!ports) return;

  const records = await ports.store.list(ctx.guildId, ctx.config.retainBackups);

  if (records.length === 0) {
    return reply(ctx, [
      'This server has no snapshots. Run `/backup create` to take one — and take it before you ' +
        'need it.',
    ]);
  }

  await reply(ctx, ['Snapshots, newest first:', ...records.map(summarise)]);
}

function summarise(record: BackupRecord): string {
  const coverage = coverageOf(record.snapshot);
  const when = Math.floor(record.createdAt.getTime() / 1000);
  const who = record.createdBy ? `<@${record.createdBy}>` : 'Proton';
  const hidden =
    coverage.obfuscatedChannelIds.length > 0
      ? `, ${coverage.obfuscatedChannelIds.length} channel(s) NOT captured`
      : '';

  return (
    `- \`${record.id}\` — <t:${when}:f>, by ${who} — ${coverage.channelsCaptured} channels, ` +
    `${coverage.rolesCaptured} roles${hidden}`
  );
}

async function restore(ctx: CommandContext<BackupConfig>, deps: BackupDeps): Promise<void> {
  const ports = await bound(ctx, deps);
  if (!ports) return;

  const backupId = ctx.options.getString('backup_id');
  if (!backupId) {
    return reply(ctx, ['I need the id of a snapshot. Run `/backup list` to see them.']);
  }

  let record: BackupRecord | null;
  try {
    record = await ports.store.get(ctx.guildId, backupId);
  } catch (error) {
    // `CorruptSnapshotError`'s message already names the backup and says what is
    // wrong with it, and is written for an admin to read.
    const detail = error instanceof Error ? error.message : String(error);
    ctx.logger.error(detail, { guildId: ctx.guildId, moduleId: MODULE_ID });
    return reply(ctx, [detail]);
  }

  if (!record) {
    return reply(ctx, [
      `This server has no snapshot with the id \`${backupId}\`. Run \`/backup list\` to see the ` +
        'ones it does have.',
    ]);
  }

  const layout = await ports.readLayout(ctx.guildId);
  if (!layout) return reply(ctx, [NO_LAYOUT]);

  const planned = planRestore({
    backupId: record.id,
    snapshot: record.snapshot,
    present: layout,
    dryRun: restoreIsDryRun(),
  });

  if (isRestoreRefusal(planned)) return reply(ctx, [planned.refusal]);

  const counts = summariseRestore(planned);
  ctx.logger.info(
    `restore preview of backup ${record.id} in guild ${ctx.guildId}: ${counts.roles} role(s) and ` +
      `${counts.channels} channel(s) to recreate, ${planned.skipped.length} skipped`,
    { guildId: ctx.guildId, moduleId: MODULE_ID },
  );

  await reply(ctx, [...describeRestore(planned), CANNOT_APPLY]);
}

/**
 * Acknowledge the interaction.
 *
 * Ephemeral always: the reply lists the server's channel structure, including
 * the ids of channels the invoker may not be able to see, and a public post of
 * that in whatever channel the command was run in is an information leak nobody
 * asked for.
 */
async function reply(ctx: CommandContext<BackupConfig>, lines: readonly string[]): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:reply`,
    // Never dry-run: I12 withholds the destructive effect, not the explanation
    // of why it was withheld.
    dryRun: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      content: clamp(lines.join('\n')),
      ephemeral: true,
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    // Nothing left to reply *with* — the log is the only channel remaining.
    ctx.logger.warn(
      `backup could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

/**
 * Cut to Discord's limit, and say that it was cut.
 *
 * A silent slice would drop the tail of a skip list — the part that says which
 * channels are not coming back — and leave the reader believing they had read
 * the whole report.
 */
function clamp(content: string): string {
  if (content.length <= CONTENT_MAX) return content;

  const notice = `\n… report truncated; ${content.length - CONTENT_MAX} characters omitted.`;
  return `${content.slice(0, CONTENT_MAX - notice.length)}${notice}`;
}
