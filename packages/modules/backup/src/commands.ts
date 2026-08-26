import { type CommandContext, type CommandDefinition, Permissions } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import { applyRestore } from './apply.ts';
import type { BackupConfig } from './config.ts';
import {
  type BackupDeps,
  type BoundBackupDeps,
  bindDeps,
  describeUnbound,
  MODULE_ID,
} from './deps.ts';
import {
  describeRestore,
  isRestoreRefusal,
  planRestore,
  restoreIsDryRun,
  summariseRestore,
} from './restore.ts';
import { buildSnapshot, coverageOf, describeCapture, SNAPSHOT_VERSION } from './snapshot.ts';
import type { BackupRecord } from './store.ts';

export { MODULE_ID };

const CONTENT_MAX = 2000;

const DISABLED =
  'Backups are switched off in this server. An admin can turn the Backup module back on from ' +
  'the Proton dashboard.';

const NO_LAYOUT =
  'Proton does not have this server’s channel and role list yet, so there is nothing to snapshot. ' +
  'That list arrives when the gateway connects to the server — try again in a moment. Nothing ' +
  'has been saved.';

const PREVIEW_ONLY =
  'Nothing was changed. Run the same command with `confirm: true` to carry this out.';

const NOT_WIRED =
  "I can't reach this server's backups because Proton isn't fully wired up in this deployment. " +
  'Nothing was saved. The Proton logs name the exact missing piece.';

const STORE_UNREADABLE =
  "I couldn't read this server's snapshots, so I don't know which ones it has. Nothing was " +
  'changed. The Proton logs name what went wrong.';

const STORE_UNWRITABLE =
  'The snapshot could not be saved, so this server has NO new backup. Nothing else was changed, ' +
  'and the Proton logs name what went wrong. Try again in a moment.';

const WRONG_SERVER =
  "I read another server's structure while snapshotting this one, so I stopped rather than save " +
  'something wrong. Nothing has been saved. This is a Proton problem, not a setting in this ' +
  'server.';

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
            .setDescription('Recreate the channels and roles from a snapshot.')
            .addStringOption((option) =>
              option
                .setName('backup_id')
                .setDescription('The id from /backup list.')
                .setRequired(true)
                .setMaxLength(64),
            )
            .addBooleanOption((option) =>
              option
                .setName('confirm')
                .setDescription('Actually carry it out. Leave off to preview the plan first.'),
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
    ctx.logger.error(describeUnbound(result.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await reply(ctx, [NOT_WIRED]);
    return null;
  }

  return result.deps;
}

async function create(ctx: CommandContext<BackupConfig>, deps: BackupDeps): Promise<void> {
  const ports = await bound(ctx, deps);
  if (!ports) return;

  const layout = await ports.readLayout(ctx.guildId);
  if (!layout) return reply(ctx, [NO_LAYOUT]);

  if (layout.guildId !== ctx.guildId) {
    ctx.logger.error(
      `read the layout of guild ${layout.guildId} while backing up ${ctx.guildId} — refusing to ` +
        'save it',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return reply(ctx, [WRONG_SERVER]);
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
    return reply(ctx, [STORE_UNWRITABLE]);
  }

  const lines = [`Backup \`${backupId}\` saved.`, ...describeCapture(report)];

  if (report.obfuscatedChannelIds.length > 0) {
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
      ? `, ${coverage.obfuscatedChannelIds.length} channel${
          coverage.obfuscatedChannelIds.length === 1 ? '' : 's'
        } NOT captured`
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
    const detail = error instanceof Error ? error.message : String(error);
    ctx.logger.error(`snapshot ${backupId} could not be read: ${detail}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return reply(ctx, [STORE_UNREADABLE]);
  }

  if (!record) {
    return reply(ctx, [
      `This server has no snapshot with the id \`${backupId}\`. Run \`/backup list\` to see the ` +
        'ones it does have.',
    ]);
  }

  const layout = await ports.readLayout(ctx.guildId);
  if (!layout) return reply(ctx, [NO_LAYOUT]);

  const confirmed = ctx.options.getBoolean('confirm') === true;

  const planned = planRestore({
    backupId: record.id,
    snapshot: record.snapshot,
    present: layout,
    dryRun: restoreIsDryRun(confirmed),
  });

  if (isRestoreRefusal(planned)) return reply(ctx, [planned.refusal]);

  const counts = summariseRestore(planned);

  if (!confirmed) {
    ctx.logger.info(
      `restore preview of backup ${record.id} in guild ${ctx.guildId}: ${counts.roles} role(s) ` +
        `and ${counts.channels} channel(s) to recreate, ${planned.skipped.length} skipped`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return reply(ctx, [...describeRestore(planned), PREVIEW_ONLY]);
  }

  ctx.logger.info(
    `restoring backup ${record.id} in guild ${ctx.guildId}: ${counts.roles} role(s) and ` +
      `${counts.channels} channel(s)`,
    { guildId: ctx.guildId, moduleId: MODULE_ID },
  );

  const applied = await applyRestore(ctx, ctx.executor, record.id, planned.ops);

  const lines = [
    `Restored ${applied.createdRoles} role${applied.createdRoles === 1 ? '' : 's'} and ` +
      `${applied.createdChannels} channel${applied.createdChannels === 1 ? '' : 's'} from ` +
      `\`${record.id}\`.`,
    ...describeRestore({ ...planned, ops: [] }).slice(1),
  ];

  if (applied.failures.length > 0) {
    lines.push(
      `${applied.failures.length} did not go through:`,
      ...applied.failures.map((failure) => `• ${failure}`),
    );
  }

  await reply(ctx, lines);
}

async function reply(ctx: CommandContext<BackupConfig>, lines: readonly string[]): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:reply`,

    dryRun: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      content: clamp(lines.join('\n')),
      ephemeral: true,
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `backup could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

function clamp(content: string): string {
  if (content.length <= CONTENT_MAX) return content;

  const notice = `\n… report truncated; ${content.length - CONTENT_MAX} characters omitted.`;
  return `${content.slice(0, CONTENT_MAX - notice.length)}${notice}`;
}
