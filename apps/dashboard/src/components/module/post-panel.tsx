import type { Postable } from '@proton/core';
import { useMutation } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { saveFailure } from '../../lib/errors.ts';
import { postModulePanel } from '../../server/modules.ts';
import { Icon } from '../shell/icon.tsx';
import type { ModuleForm } from './form.ts';
import { useForm } from './inputs.tsx';

export interface PostPanelProps {
  // The postable's id, as the module's own `postables()` names it.
  panelId: string;
  label?: string;
}

/**
 * Why the button is off, in the words the admin needs to hear, or null when it may be pressed.
 * Ordered by what they must do first: save, then switch the module on, then give it a channel.
 */
export function postBlocked(
  form: Pick<ModuleForm, 'dirty' | 'summary'>,
  postable: Postable | undefined,
): string | null {
  // An unsaved edit is not in the config the worker will read, so posting now would publish the
  // last saved version and look like the button ignoring what is on screen.
  if (form.dirty) return 'Save first — Proton posts what is stored, not what is on screen.';

  if (!form.summary.enabled) {
    return `${form.summary.name} is switched off, so this would post a message nobody can use.`;
  }

  if (!postable) return 'This has not been saved yet, so there is nothing to post.';
  if (!postable.channelId) return 'Pick a channel for this and save, then post it.';

  return null;
}

/**
 * "Post it now", beside the channel the message goes in. Every panel Proton keeps in a channel had
 * to be published by running a slash command in Discord — the role-menu editor still said so in
 * prose — which meant leaving the page that had just configured it.
 *
 * The api cannot talk to Discord, so this says *asked*, never *posted*: the worker does the send,
 * and claiming otherwise here would be the one thing the product promises never to do.
 */
export function PostPanel({ panelId, label = 'Post to Discord' }: PostPanelProps): ReactElement {
  const form = useForm();
  const postable = form.postables.find((candidate) => candidate.id === panelId);

  const post = useMutation({
    mutationFn: () =>
      postModulePanel({ data: { guildId: form.guildId, moduleId: form.moduleId, panelId } }),
  });

  const blocked = postBlocked(form, postable);

  return (
    <div className="post-panel">
      <button
        type="button"
        className="button button-quiet"
        disabled={blocked !== null || post.isPending}
        onClick={() => post.mutate()}
      >
        <Icon name="paper-plane-tilt" />
        {post.isPending ? 'Sending…' : label}
      </button>

      {blocked ? (
        <span className="post-panel-note">{blocked}</span>
      ) : post.error ? (
        <span className="post-panel-note post-panel-failed" role="alert">
          <Icon name="warning-circle" weight="fill" />
          {saveFailure(post.error, 'Proton could not be asked to post this')}
        </span>
      ) : post.isSuccess ? (
        <span className="post-panel-note post-panel-sent">
          <Icon name="check-circle" weight="fill" />
          Asked Proton to post it. It appears in the channel a moment later.
        </span>
      ) : null}
    </div>
  );
}
