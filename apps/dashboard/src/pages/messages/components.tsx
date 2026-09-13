import type { ActionRow, ProtonMessage } from '@proton/core';
import { rowKeys } from '@proton/core';
import type { MessagesConfig, SavedComponent } from '@proton/module-messages/config';
import { COMPONENT_NAME_MAX, MAX_SAVED_COMPONENTS } from '@proton/module-messages/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { EditorPreviewLayout } from '../../components/discord/message-editor.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { RoleName } from '../../components/discord/role-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { ModuleLink, useModuleNavigate } from '../../components/module/route.tsx';
import {
  CollectionButtonRow,
  CollectionHeader,
  MetaSeparator,
} from '../../components/ui/collection.tsx';
import { Button, Field, SegmentedControl, TextInput } from '../../components/ui/controls.tsx';
import { EmptyState, Spinner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { ConfirmDialog, Dialog, MenuButton } from '../../components/ui/overlay.tsx';
import { rolesQuery } from '../../lib/queries.ts';
import { type KeyContext, Labelled, RowEditor } from './row-editor.tsx';
import { describeRow, emptyComponent, rowActions, uniqueName } from './shared.ts';

const WHY_A_ROW =
  'Save a row of buttons or a dropdown once, then insert it into any template. Each template gets ' +
  'its own copy.';

const EMPTY_BODY = 'Start by creating one.';

const NAME_HELP = 'Shown when inserting the row into a template. Members never see it.';

const KEYS_ARE_FRESHENED =
  'Keys only need to be unique within this row. When a template already uses one, Proton renames ' +
  'it in the inserted copy.';

const KIND_OPTIONS = [
  { value: 'buttons' as const, label: 'Buttons' },
  { value: 'select' as const, label: 'Dropdown' },
];

interface Search {
  id?: string | undefined;
}

interface AreaProps {
  guildId: string;
  moduleId: string;
  form: ModuleForm<MessagesConfig>;
  search: Search;
  index: number;
}

function duplicateName(name: string): string {
  return `two saved components are both called '${name}' — the palette could not say which of them you were inserting.`;
}

function previewOf(row: ActionRow): Partial<ProtonMessage> {
  return { components: [row] };
}

function ActionSummary({ guildId, row }: { guildId: string; row: ActionRow }): ReactElement | null {
  const { data, isPending } = useQuery(rolesQuery(guildId));

  const actions = rowActions(row);
  if (actions.length === 0) return null;

  const roles = actions.flatMap((action) => (action.kind === 'role' ? [action.roleId] : []));
  const replies = actions.filter((action) => action.kind === 'reply').length;

  return (
    <>
      <MetaSeparator />
      {roles.length > 0 && isPending ? (
        <Spinner label="Loading roles" />
      ) : (
        roles.map((roleId) => (
          <RoleName
            key={roleId}
            id={roleId}
            role={(data ?? []).find((role) => role.id === roleId)}
          />
        ))
      )}
      {replies > 0 ? <span>{replies === 1 ? '1 reply' : `${replies} replies`}</span> : null}
    </>
  );
}

export function ComponentsArea(props: AreaProps): ReactElement {
  const entry = props.index >= 0 ? props.form.value.components[props.index] : undefined;

  if (entry) return <ComponentEditor {...props} entry={entry} />;

  if (props.search.id !== undefined) {
    return (
      <EmptyState icon="squares-four" title="Saved row not found" inset>
        It may have been renamed or deleted.{' '}
        <ModuleLink
          guildId={props.guildId}
          moduleId={props.moduleId}
          search={{ area: 'components' }}
        >
          Back to saved rows
        </ModuleLink>
      </EmptyState>
    );
  }

  return <ComponentList {...props} />;
}

function ComponentList({ guildId, moduleId, form }: AreaProps): ReactElement {
  const go = useModuleNavigate(guildId, moduleId);

  const entries = form.value.components;
  const full = entries.length >= MAX_SAVED_COMPONENTS;

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ActionRow['kind']>('buttons');

  const typed = name.trim();
  const taken = entries.map((entry) => entry.name.trim().toLowerCase());
  const nameError =
    typed !== '' && taken.includes(typed.toLowerCase()) ? duplicateName(typed) : undefined;

  const create = (): void => {
    form.setValue((current) => ({
      ...current,
      components: [...current.components, emptyComponent(typed, kind)],
    }));

    setCreating(false);
    setName('');

    go({ area: 'components', id: typed.toLowerCase() });
  };

  return (
    <>
      <CollectionHeader
        title="Saved rows"
        used={entries.length}
        ceiling={MAX_SAVED_COMPONENTS}
        limitLabel="saved rows"
        actions={
          <Button
            tone="primary"
            icon="plus"
            disabled={full}
            title={
              full
                ? `You can add up to ${MAX_SAVED_COMPONENTS} saved rows. Delete one to add another.`
                : undefined
            }
            onClick={() => setCreating(true)}
          >
            Create saved row
          </Button>
        }
      />

      <p className="section-intro">{WHY_A_ROW}</p>

      {entries.length === 0 ? (
        <EmptyState icon="squares-four" title="No saved rows" inset>
          {EMPTY_BODY}
        </EmptyState>
      ) : (
        <Rows>
          {entries.map((entry) => (
            <CollectionButtonRow
              key={entry.name.trim().toLowerCase()}
              icon="squares-four"
              title={entry.name}
              meta={
                <>
                  {describeRow(entry.row)}
                  <ActionSummary guildId={guildId} row={entry.row} />
                </>
              }
              onSelect={() => go({ area: 'components', id: entry.name.trim().toLowerCase() })}
            />
          ))}
        </Rows>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Create saved row"
        description="The type cannot be changed later."
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              tone="primary"
              disabled={typed === '' || nameError !== undefined}
              onClick={create}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="stack stack-12">
          <Field label="Name" hint={NAME_HELP} error={nameError}>
            {(props) => (
              <TextInput
                {...props}
                width="lg"
                maxLength={COMPONENT_NAME_MAX}
                invalid={nameError !== undefined}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            )}
          </Field>

          <Labelled label="Type">
            <SegmentedControl
              label="Row type"
              options={KIND_OPTIONS}
              value={kind}
              onChange={setKind}
            />
          </Labelled>
        </div>
      </Dialog>
    </>
  );
}

function ComponentEditor({
  guildId,
  moduleId,
  form,
  index,
  entry,
}: AreaProps & { entry: SavedComponent }): ReactElement {
  const go = useModuleNavigate(guildId, moduleId);
  const [removing, setRemoving] = useState(false);

  const path = `components.${index}`;

  const setEntry = (next: SavedComponent): void => {
    form.setValue((current) => ({
      ...current,
      components: current.components.map((held, at) => (at === index ? next : held)),
    }));
  };

  const keys = useMemo<KeyContext>(() => {
    const all = rowKeys(entry.row);
    const counts = new Map<string, number>();
    for (const key of all) counts.set(key, (counts.get(key) ?? 0) + 1);

    // No custom_id length check here: the length depends on the template name this row is later
    // inserted into, which the palette does not know.
    return { counts, taken: new Set(all), subject: 'row', customId: null };
  }, [entry.row]);

  const clash = form.value.components.some(
    (held, at) =>
      at !== index && held.name.trim().toLowerCase() === entry.name.trim().toLowerCase(),
  );

  const nameError = clash
    ? duplicateName(entry.name)
    : entry.name.trim() === ''
      ? 'Saved row needs a name.'
      : form.errorAt(`${path}.name`);

  const remove = (): void => {
    form.setValue((current) => ({
      ...current,
      components: current.components.filter((_, at) => at !== index),
    }));

    go({ area: 'components', id: undefined });
  };

  const duplicate = (): void => {
    const name = uniqueName(
      `${entry.name} copy`,
      form.value.components.map((held) => held.name),
      COMPONENT_NAME_MAX,
    );

    form.setValue((current) => ({
      ...current,
      components: [...current.components, { ...entry, name }],
    }));

    go({ area: 'components', id: name.toLowerCase() });
  };

  return (
    <>
      <EditorPreviewLayout
        editor={
          <>
            <div className="messages-toolbar">
              <span className="text-sm text-muted">{describeRow(entry.row)}</span>
              <span className="push-right">
                <MenuButton
                  label="Saved row actions"
                  actions={[
                    {
                      id: 'duplicate',
                      label: 'Duplicate',
                      icon: 'clipboard-text',
                      onSelect: duplicate,
                    },
                    {
                      id: 'delete',
                      label: 'Delete',
                      icon: 'trash',
                      danger: true,
                      onSelect: () => setRemoving(true),
                    },
                  ]}
                />
              </span>
            </div>

            <Section label="Saved row">
              <Rows>
                <SettingRow title="Name" description={NAME_HELP} error={nameError}>
                  <TextInput
                    width="md"
                    aria-label="Saved row name"
                    maxLength={COMPONENT_NAME_MAX}
                    invalid={nameError !== undefined}
                    value={entry.name}
                    onChange={(event) => setEntry({ ...entry, name: event.currentTarget.value })}
                  />
                </SettingRow>
              </Rows>
            </Section>

            <Section label={entry.row.kind === 'select' ? 'Dropdown' : 'Buttons'}>
              <RowEditor
                guildId={guildId}
                row={entry.row}
                keys={keys}
                errorAt={(at) => form.errorAt(at)}
                prefix={`${path}.row`}
                onChange={(row) => setEntry({ ...entry, row })}
                onRemove={() => setRemoving(true)}
              />
              <p className="text-xs text-muted">{KEYS_ARE_FRESHENED}</p>
            </Section>
          </>
        }
        previewTitle="Discord preview"
        preview={<DiscordPreview message={previewOf(entry.row)} empty="This row is empty." />}
      />

      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        onConfirm={remove}
        title={`Delete ${entry.name}?`}
        confirmLabel="Delete"
        danger
      >
        Templates that already use this row keep their own copy.
      </ConfirmDialog>
    </>
  );
}
