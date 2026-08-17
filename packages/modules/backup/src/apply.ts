import type { ActionExecutor, ActionResult, CommandContext } from '@proton/core';
import type { BackupConfig } from './config.ts';
import { MODULE_ID } from './deps.ts';
import type { RestoreOp } from './restore.ts';

export interface AppliedRestore {
  createdRoles: number;
  createdChannels: number;
  failures: string[];
}

function createdId(result: ActionResult): string | null {
  const body = result.body;
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

// Categories before their children, roles before everything. A child created before its category
// would be parented to an id that does not exist yet, and Discord answers that with a 400 naming
// only the field.
function ordered(ops: readonly RestoreOp[]): RestoreOp[] {
  const roles = ops.filter((op) => op.op === 'create_role');
  const channels = ops.filter((op) => op.op === 'create_channel');
  const categories = channels.filter((op) => op.op === 'create_channel' && op.channel.type === 4);
  const rest = channels.filter((op) => op.op === 'create_channel' && op.channel.type !== 4);

  return [...roles, ...categories, ...rest];
}

export async function applyRestore(
  ctx: CommandContext<BackupConfig>,
  executor: ActionExecutor,
  backupId: string,
  ops: readonly RestoreOp[],
): Promise<AppliedRestore> {
  const applied: AppliedRestore = { createdRoles: 0, createdChannels: 0, failures: [] };

  // The snapshot's parentId is the id the category had *before* it was deleted. The category we
  // just recreated has a new one, so children are re-parented through this map rather than
  // inheriting an id that now belongs to nothing.
  const newCategoryId = new Map<string, string>();

  for (const [index, op] of ordered(ops).entries()) {
    const key = `${MODULE_ID}:${ctx.guildId}:${backupId}:${index}`;

    if (op.op === 'create_role') {
      const result = await executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'create_role',
        actorId: ctx.userId,
        reason: `Restoring backup ${backupId}`,
        idempotencyKey: key,
        dryRun: false,
        payload: {
          name: op.role.name,
          permissions: op.role.permissions,
          color: op.role.color,
          hoist: op.role.hoist,
          mentionable: op.role.mentionable,
        },
      });

      if (result.status === 'executed') applied.createdRoles += 1;
      else applied.failures.push(`role ${op.role.name}: ${describe(result)}`);
      continue;
    }

    const name = op.channel.name;
    if (name === null) {
      applied.failures.push(`a channel could not be recreated because its name was not readable`);
      continue;
    }

    const parent = op.channel.parentId ? newCategoryId.get(op.channel.parentId) : undefined;

    const result = await executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_channel',
      actorId: ctx.userId,
      reason: `Restoring backup ${backupId}`,
      idempotencyKey: key,
      dryRun: false,
      payload: {
        name,
        type: op.channel.type,
        position: op.channel.position,
        ...(parent ? { parentId: parent } : {}),
        ...(op.channel.topic !== null ? { topic: op.channel.topic } : {}),
        ...(op.channel.nsfw !== null ? { nsfw: op.channel.nsfw } : {}),
        ...(op.channel.rateLimitPerUser !== null
          ? { rateLimitPerUser: op.channel.rateLimitPerUser }
          : {}),
      },
    });

    if (result.status !== 'executed') {
      applied.failures.push(`channel ${name}: ${describe(result)}`);
      continue;
    }

    applied.createdChannels += 1;

    const created = createdId(result);
    if (op.channel.type === 4 && created) newCategoryId.set(op.channel.id, created);
    else if (op.channel.type === 4) {
      // Without the new id every channel under this category lands at the top level. Say so
      // rather than letting the restore look complete.
      applied.failures.push(
        `category ${name} was created but Discord did not return its id, so channels that sat ` +
          'under it were restored to the top level',
      );
    }
  }

  return applied;
}

function describe(result: ActionResult): string {
  return result.failure?.humanReason ?? `it ${result.status}`;
}
