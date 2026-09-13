import {
  MENU_ID_MAX,
  type RolemenuKind,
  type RolemenuMenu,
  type RolemenuMode,
} from '@proton/module-rolemenu/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ChannelPicker, POSTABLE_CHANNEL_TYPES } from '../../components/discord/channel-picker.tsx';
import { SegmentedControl, TextInput } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { ConfirmDialog } from '../../components/ui/overlay.tsx';
import { channelsQuery } from '../../lib/queries.ts';
import { BindingLadder } from './bindings.tsx';
import { AFTER_FIRST_POST, PostAction, postRefusal, reactionInsteadOfPost } from './post.tsx';
import { MenuPreview } from './preview.tsx';
import {
  CHANNEL_HELP,
  KIND_HELP,
  KIND_OPTIONS,
  MENU_ID_HELP,
  MESSAGE_ID_HELP,
  MODE_HELP,
  MODE_OPTIONS,
  menuHasProblem,
  type Problems,
  REACTION_MESSAGE_REQUIRED,
  RENAME_WARNING,
  type RolemenuForm,
  SELECT_UNPICK_NOTE,
  setMenu,
} from './shape.ts';

export function MenuEditor({
  form,
  guildId,
  moduleId,
  enabled,
  index,
  menu,
  problems,
  onIdSettled,
}: {
  form: RolemenuForm;
  guildId: string;
  moduleId: string;
  enabled: boolean;
  index: number;
  menu: RolemenuMenu;
  problems: Problems;
  onIdSettled: (menuId: string) => void;
}): ReactElement {
  const [pendingKind, setPendingKind] = useState<RolemenuKind | null>(null);
  const [posted, setPosted] = useState(false);

  const { data: channels } = useQuery(channelsQuery(guildId));
  const channel = (channels ?? []).find((candidate) => candidate.id === menu.channelId);

  const base = `menus.${index}`;
  const at = (path: string): string | undefined =>
    problems.get(`${base}.${path}`) ?? form.errorAt(`${base}.${path}`);

  const write = (next: Partial<RolemenuMenu>): void => setMenu(form, index, { ...menu, ...next });

  const saved = form.view.postables.some((postable) => postable.id === menu.id);
  const refusal = postRefusal({
    menu,
    enabled,
    dirty: form.dirty,
    saved,
    broken: menuHasProblem(problems, index),
  });

  // Emoji keys and routing keys are not interchangeable, so crossing the reaction boundary clears
  // every key rather than carrying an emoji into a custom_id it can never round-trip through.
  const changeKind = (next: RolemenuKind): void => {
    if (next === menu.kind) return;

    const crosses = (menu.kind === 'reaction') !== (next === 'reaction');
    if (crosses && menu.bindings.length > 0) {
      setPendingKind(next);
      return;
    }

    write({ kind: next });
  };

  const commitKind = (next: RolemenuKind): void => {
    setMenu(form, index, {
      ...menu,
      kind: next,
      bindings: menu.bindings.map((binding) => ({ ...binding, key: '' })),
    });
    setPendingKind(null);
  };

  const idField = (
    <SettingRow
      title="Menu ID"
      description={MENU_ID_HELP}
      error={at('id')}
      note={menu.messageId !== undefined ? RENAME_WARNING : undefined}
    >
      <TextInput
        className="mono"
        width="md"
        spellCheck={false}
        aria-label="Menu ID"
        maxLength={MENU_ID_MAX}
        invalid={at('id') !== undefined}
        value={menu.id}
        onChange={(event) => write({ id: event.currentTarget.value })}
        onBlur={() => onIdSettled(menu.id)}
      />
    </SettingRow>
  );

  const channelField = (
    <SettingRow title="Channel" description={CHANNEL_HELP} error={at('channelId')}>
      <ChannelPicker
        guildId={guildId}
        label="Channel"
        types={POSTABLE_CHANNEL_TYPES}
        allowNone={false}
        invalid={at('channelId') !== undefined}
        value={menu.channelId === '' ? null : menu.channelId}
        onChange={(channelId) => write({ channelId: channelId ?? '' })}
      />
    </SettingRow>
  );

  const messageField = (
    <SettingRow
      title="Message ID"
      description={menu.kind === 'reaction' ? REACTION_MESSAGE_REQUIRED : MESSAGE_ID_HELP}
      error={at('messageId')}
    >
      <TextInput
        className="mono"
        width="md"
        spellCheck={false}
        inputMode="numeric"
        aria-label="Message ID"
        placeholder={menu.kind === 'reaction' ? 'Required' : 'Post a new message'}
        maxLength={20}
        invalid={at('messageId') !== undefined}
        value={menu.messageId ?? ''}
        onChange={(event) => {
          const raw = event.currentTarget.value.trim();
          write({ messageId: raw === '' ? undefined : raw });
        }}
      />
    </SettingRow>
  );

  return (
    <div className="editor">
      <div className="editor-main">
        <Section label="Menu">
          <Rows>
            {idField}
            {menu.kind === 'reaction' ? (
              <>
                {messageField}
                {channelField}
              </>
            ) : (
              <>
                {channelField}
                {messageField}
              </>
            )}
          </Rows>
        </Section>

        <Section label="Behaviour">
          <Rows>
            <SettingRow title="Style" description={KIND_HELP[menu.kind]} stacked>
              <SegmentedControl
                label="Style"
                options={KIND_OPTIONS}
                value={menu.kind}
                onChange={changeKind}
              />
            </SettingRow>

            <SettingRow
              title="Mode"
              description={MODE_HELP[menu.mode]}
              note={menu.kind === 'select' ? SELECT_UNPICK_NOTE : undefined}
              stacked
            >
              <SegmentedControl
                label="Mode"
                options={MODE_OPTIONS}
                value={menu.mode}
                onChange={(mode: RolemenuMode) => write({ mode })}
              />
            </SettingRow>
          </Rows>
        </Section>

        <BindingLadder
          form={form}
          guildId={guildId}
          index={index}
          menu={menu}
          problems={problems}
        />
      </div>

      <div className="editor-preview">
        <div className="editor-preview-head">
          <span className="editor-preview-title">
            {menu.kind === 'reaction' ? 'Reactions' : 'Preview'}
          </span>
        </div>

        <MenuPreview menu={menu} guildId={guildId} channelName={channel?.name} />

        {menu.kind === 'reaction' ? (
          <p className="rolemenu-preview-note">{reactionInsteadOfPost(menu.id)}</p>
        ) : (
          <div className="rolemenu-post">
            <PostAction
              guildId={guildId}
              moduleId={moduleId}
              menu={menu}
              channelName={channel?.name}
              refusal={refusal}
              onPosted={() => setPosted(menu.messageId === undefined)}
            />
            {refusal !== undefined ? <p className="rolemenu-post-reason">{refusal}</p> : null}
          </div>
        )}

        {posted ? <p className="rolemenu-preview-note">{AFTER_FIRST_POST}</p> : null}
      </div>

      {pendingKind !== null ? (
        <ConfirmDialog
          open
          title="Change style?"
          confirmLabel="Change"
          onClose={() => setPendingKind(null)}
          onConfirm={() => commitKind(pendingKind)}
        >
          Reaction menus match each role to an emoji; buttons and dropdowns match it to a key.
          Changing between them clears the emoji or key on all {menu.bindings.length}{' '}
          {menu.bindings.length === 1 ? 'role' : 'roles'}, but keeps the roles.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
