import type { RolemenuMenu } from '@proton/module-rolemenu/config';
import { useMutation } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Button } from '../../components/ui/controls.tsx';
import { AsyncOperationStatus, type AsyncPhase } from '../../components/ui/feedback.tsx';
import { saveFailure } from '../../lib/errors.ts';
import { postModulePanel } from '../../server/modules.ts';

const MODULE_OFF =
  'Role menus is switched off in this server, so posting this would put a message nobody can use ' +
  'in a channel. Switch it on first.';

const UNSAVED = 'Save your changes first. Posting uses the last saved version.';

const NEVER_SAVED = 'Save this role menu first. Nothing is saved to post yet.';

export function reactionInsteadOfPost(menuId: string): string {
  return `Use /rolemenu menu:${menuId} in Discord to add the reactions.`;
}

export const AFTER_FIRST_POST =
  'Copy the new message’s ID into Message ID above, so the next post updates it instead of ' +
  'adding a second copy.';

export function postRefusal({
  menu,
  enabled,
  dirty,
  saved,
  broken,
}: {
  menu: RolemenuMenu;
  enabled: boolean;
  dirty: boolean;
  saved: boolean;
  broken: boolean;
}): string | undefined {
  if (!enabled) return MODULE_OFF;
  if (menu.channelId === '') {
    return `'${menu.id}' has no channel to go in yet. Pick one and save, then post it.`;
  }
  if (broken) return 'Fix the marked settings before posting.';
  if (dirty) return UNSAVED;
  if (!saved) return NEVER_SAVED;
  return undefined;
}

function askedLabel(refreshing: boolean, channelName: string | undefined): string {
  const where = channelName === undefined ? 'the channel' : `#${channelName}`;
  return refreshing
    ? `Asked Proton to update it. Check ${where} in Discord to confirm it changed.`
    : `Asked Proton to post it. Check ${where} in Discord to confirm it appeared.`;
}

/**
 * Asked, not posted: the api records the request and the worker is the only process that talks to
 * Discord, so the success wording never claims the message went out.
 */
export function PostAction({
  guildId,
  moduleId,
  menu,
  channelName,
  requestedLabel,
  refusal,
  onPosted,
}: {
  guildId: string;
  moduleId: string;
  menu: RolemenuMenu;
  channelName: string | undefined;
  requestedLabel?: string | undefined;
  refusal: string | undefined;
  onPosted?: (() => void) | undefined;
}): ReactElement {
  const post = useMutation({
    mutationFn: () => postModulePanel({ data: { guildId, moduleId, panelId: menu.id } }),
    onSuccess: () => onPosted?.(),
  });

  const phase: AsyncPhase = post.isPending
    ? 'working'
    : post.isError
      ? 'failed'
      : post.isSuccess
        ? 'requested'
        : 'idle';

  const refreshing = menu.messageId !== undefined;

  return (
    <>
      <AsyncOperationStatus
        phase={phase}
        workingLabel={refreshing ? 'Updating…' : 'Posting…'}
        requestedLabel={requestedLabel ?? askedLabel(refreshing, channelName)}
        failedLabel={
          post.error
            ? saveFailure(
                post.error,
                refreshing ? 'Role menu was not updated' : 'Role menu was not posted',
              )
            : undefined
        }
      />
      <Button
        size="sm"
        icon="megaphone"
        disabled={refusal !== undefined}
        title={refusal}
        busy={post.isPending}
        onClick={() => post.mutate()}
      >
        {refreshing ? 'Update' : 'Post'}
      </Button>
    </>
  );
}
