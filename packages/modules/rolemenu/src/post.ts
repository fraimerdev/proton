import type { ActionExecutor } from '@proton/core';
import type { RolemenuMenu } from './config.ts';
import { buildComponents } from './message.ts';
import { MODULE_ID, succeeded } from './perform.ts';

export interface PostMenuResult {
  ok: boolean;
  refreshed: boolean;
  humanReason?: string;
}

export interface PostMenuOptions {
  actorId: string;
  idempotencyKey: string;
  content?: string | undefined;
}

/**
 * Posting one menu, with no interaction and no reply. `/rolemenu` and the dashboard's own button
 * both land here, so a menu posted from the page is the message the command would have made —
 * before this the posting lived inside the command handler and the dashboard could only tell an
 * admin to go and run it.
 */
export async function postMenu(
  ctx: { guildId: string; executor: ActionExecutor },
  menu: RolemenuMenu,
  options: PostMenuOptions,
): Promise<PostMenuResult> {
  const refreshing = menu.messageId !== undefined;

  const built = buildComponents(menu);
  if (!built.ok) return { ok: false, refreshed: refreshing, humanReason: built.humanReason };

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: refreshing ? 'edit_message' : 'send',
    actorId: options.actorId,
    dryRun: false,
    idempotencyKey: `${MODULE_ID}:${options.idempotencyKey}:post:${menu.id}`,
    payload: {
      channelId: menu.channelId,
      ...(menu.messageId ? { messageId: menu.messageId } : {}),
      ...(options.content ? { content: options.content } : {}),
      components: built.components,
    },
  });

  if (succeeded(result)) return { ok: true, refreshed: refreshing };

  return {
    ok: false,
    refreshed: refreshing,
    humanReason: result.failure?.humanReason ?? 'no reason was reported',
  };
}
