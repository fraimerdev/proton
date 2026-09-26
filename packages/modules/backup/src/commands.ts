import {
  type ActionResult,
  type CommandContext,
  type CommandDefinition,
  deferEphemeral,
  type FollowUpTo,
  followUp,
  labelOf,
  Permissions,
  type StatusKind,
  statusBody,
} from '@proton/core';
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

const DISABLED = 'Backup is off in this server. An admin can turn it on in the Proton dashboard.';

const NO_LAYOUT =
  'I don’t have this server’s channel and role list yet. It arrives once I finish connecting ' +
  'to Discord, so try again in a moment.';

const PREVIEW_ONLY = 'To go ahead, run the same command with `confirm: true`.';

const NOT_WIRED =
  'I can’t reach this server’s backups. Nothing was saved or changed. This is a problem on my ' +
  'side, not a setting in this server.';

const STORE_UNREADABLE =
  'I couldn’t read this server’s snapshots, so I don’t know which ones it has. Nothing was ' +
  'changed. This is a problem on my side, not a setting in this server.';

const STORE_UNWRITABLE =
  'Couldn’t save the snapshot, so this server has **no** new backup. Try again in a moment.';

const WRONG_SERVER =
  'I read another server’s layout while taking this snapshot, so I stopped rather than save ' +
  'something wrong. Nothing was saved. This is a problem on my side, not a setting in this ' +
  'server.';

export function createBackupCommands(deps: BackupDeps): CommandDefinition<BackupConfig>[] {
  return [
    {
      name: 'backup',
      description: 'Snapshot this server’s channels and roles, and restore missing ones.',

      data: new SlashCommandBuilder()
        .setName('backup')
        .setDescription('Snapshot this server’s channels and roles, and restore missing ones.')
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(Permissions.ManageGuild)
        .addSubcommand((sub) =>
          sub
            .setName('create')
            .setDescription('Take a snapshot of every channel, role and channel permission.'),
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Show the snapshots this server has kept.'),
        )
        .addSubcommand((sub) =>
          sub
            .setName('restore')
            .setDescription('Recreate the missing channels and roles from a snapshot.')
            .addStringOption((option) =>
              option
                .setName('backup_id')
                .setDescription('The snapshot ID from /backup list.')
                .setRequired(true)
                .setMaxLength(64),
            )
            .addBooleanOption((option) =>
              option
                .setName('confirm')
                .setDescription(
                  'Set to True to recreate them. Leave it out to see a preview first.',
                ),
            ),
        )
        .toJSON(),

      async handler(ctx) {
        const answer = await acknowledge(ctx);

        switch (ctx.options.getSubcommand()) {
          case 'list':
            return list(ctx, deps, answer);
          case 'restore':
            return restore(ctx, deps, answer);
          default:
            return create(ctx, deps, answer);
        }
      },
    },
  ];
}

type Ctx = CommandContext<BackupConfig>;

type Answer = (lines: readonly string[], kind?: StatusKind) => Promise<void>;

async function bound(ctx: Ctx, deps: BackupDeps, answer: Answer): Promise<BoundBackupDeps | null> {
  if (!ctx.config.enabled) {
    await answer([DISABLED], 'error');
    return null;
  }

  const result = bindDeps(deps);
  if ('unbound' in result) {
    ctx.logger.error(describeUnbound(result.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await answer([NOT_WIRED], 'error');
    return null;
  }

  return result.deps;
}

async function create(ctx: Ctx, deps: BackupDeps, answer: Answer): Promise<void> {
  const ports = await bound(ctx, deps, answer);
  if (!ports) return;

  const layout = await ports.readLayout(ctx.guildId);
  if (!layout) return answer([NO_LAYOUT], 'error');

  if (layout.guildId !== ctx.guildId) {
    ctx.logger.error(
      `read the layout of guild ${layout.guildId} while backing up ${ctx.guildId} — refusing to ` +
        'save it',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return answer([WRONG_SERVER], 'error');
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
    return answer([STORE_UNWRITABLE], 'error');
  }

  const lines = [`Backup \`${backupId}\` saved.`, ...describeCapture(report, ctx)];

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

  await answer(lines, 'success');
}

async function list(ctx: Ctx, deps: BackupDeps, answer: Answer): Promise<void> {
  const ports = await bound(ctx, deps, answer);
  if (!ports) return;

  const records = await ports.store.list(ctx.guildId, ctx.config.retainBackups);

  if (records.length === 0) {
    return answer([
      `This server has no snapshots. Run \`${labelOf(ctx, 'backup', 'create')}\` to take one ` +
        'before you need it.',
    ]);
  }

  await answer(['Snapshots, newest first:', ...records.map(summarise)]);
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function summarise(record: BackupRecord): string {
  const coverage = coverageOf(record.snapshot);
  const when = Math.floor(record.createdAt.getTime() / 1000);
  const who = record.createdBy ? `<@${record.createdBy}>` : 'Proton';
  const hidden =
    coverage.obfuscatedChannelIds.length > 0
      ? `, **${counted(coverage.obfuscatedChannelIds.length, 'channel')} not captured**`
      : '';

  return (
    `- \`${record.id}\` · <t:${when}:f> by ${who} · ` +
    `${counted(coverage.channelsCaptured, 'channel')}, ${counted(coverage.rolesCaptured, 'role')}` +
    hidden
  );
}

async function restore(ctx: Ctx, deps: BackupDeps, answer: Answer): Promise<void> {
  const ports = await bound(ctx, deps, answer);
  if (!ports) return;

  const listing = labelOf(ctx, 'backup', 'list');

  const backupId = ctx.options.getString('backup_id');
  if (!backupId) {
    return answer([`I need a snapshot ID. Run \`${listing}\` to see them.`], 'error');
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
    return answer([STORE_UNREADABLE], 'error');
  }

  if (!record) {
    return answer(
      [
        `This server has no snapshot with the ID \`${backupId}\`. Run \`${listing}\` to see the ` +
          'ones it has.',
      ],
      'error',
    );
  }

  const layout = await ports.readLayout(ctx.guildId);
  if (!layout) return answer([NO_LAYOUT], 'error');

  const confirmed = ctx.options.getBoolean('confirm') === true;

  const planned = planRestore({
    backupId: record.id,
    snapshot: record.snapshot,
    present: layout,
    dryRun: restoreIsDryRun(confirmed),
  });

  if (isRestoreRefusal(planned)) return answer([planned.refusal], 'error');

  const counts = summariseRestore(planned);

  if (!confirmed) {
    ctx.logger.info(
      `restore preview of backup ${record.id} in guild ${ctx.guildId}: ${counts.roles} role(s) ` +
        `and ${counts.channels} channel(s) to recreate, ${planned.skipped.length} skipped`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return answer([...describeRestore(planned), PREVIEW_ONLY]);
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
      `${applied.failures.length} didn’t go through:`,
      ...applied.failures.map((failure) => `- ${failure}`),
    );
  }

  // Red when anything in the plan did not land: a restore that recreated half a server is not a
  // restore, and the lines above already name every op that failed.
  await answer(lines, applied.failures.length > 0 ? 'error' : 'success');
}

function bodyOf(lines: readonly string[], kind: StatusKind | undefined) {
  const content = clamp(lines.join('\n'));
  return kind === undefined ? { content } : statusBody(kind, content);
}

function warnUnanswered(ctx: Ctx, result: ActionResult): void {
  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `backup could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

async function reply(ctx: Ctx, lines: readonly string[], kind?: StatusKind): Promise<void> {
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
      ...bodyOf(lines, kind),
      ephemeral: true,
    },
  });

  warnUnanswered(ctx, result);
}

async function acknowledge(ctx: Ctx): Promise<Answer> {
  const applicationId = ctx.applicationId;
  // Without an application id there is no followup webhook, so the one callback must be the answer.
  if (!applicationId) return (lines, kind) => reply(ctx, lines, kind);

  const to: FollowUpTo = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: ctx.interaction,
    idempotencyKey: ctx.idempotencyKey,
    applicationId,
  };

  warnUnanswered(ctx, await ctx.executor.execute(deferEphemeral(to)));

  return async (lines, kind) =>
    warnUnanswered(
      ctx,
      await ctx.executor.execute(followUp(to, { ...bodyOf(lines, kind), ephemeral: true })),
    );
}

function clamp(content: string): string {
  if (content.length <= CONTENT_MAX) return content;

  const notice = '\n…and more that doesn’t fit in one message.';
  return `${content.slice(0, CONTENT_MAX - notice.length)}${notice}`;
}
