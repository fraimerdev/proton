import { checkListLimit, LIMIT_LABELS } from '@proton/core';
import { PANEL_BODY_DEFAULT, type PanelConfig } from '@proton/module-applications/config';
import { PANEL_BUTTON_FORMS_MAX, PANEL_ID_MAX } from '@proton/module-applications/constants';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { ChannelName, useChannelIndex } from '../../components/discord/channel-picker.tsx';
import { CollectionHeader, CollectionStaticRow } from '../../components/ui/collection.tsx';
import { Badge, Button, Field, TextInput } from '../../components/ui/controls.tsx';
import {
  AsyncOperationStatus,
  type AsyncPhase,
  EmptyState,
  StatusBanner,
} from '../../components/ui/feedback.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { ConfirmDialog, Dialog, MenuButton } from '../../components/ui/overlay.tsx';
import type { GuildChannel } from '../../lib/discord.ts';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import { postModulePanel } from '../../server/modules.ts';
import { formsOverviewQuery } from './admin-queries.ts';
import {
  type ApplicationsForm,
  type FormEntry,
  failureText,
  idProblem,
  PANEL_STYLE_OPTIONS,
  panelForms,
  panelIds,
  panelRefusal,
  slugify,
  slugTyping,
  uniqueId,
} from './shape.ts';

const NAME_MAX = 80;

const ID_HINT = 'Proton refers to the panel by its ID. You can’t change it later.';

const ASKED =
  'Asked Proton to post it. Check the channel in Discord. Each post adds a new message.';

const NO_FORMS = 'Create a form first. A panel lists forms for members to pick from.';

export function PanelsArea({
  form,
  guildId,
  moduleId,
  enabled,
  onOpen,
}: {
  form: ApplicationsForm;
  guildId: string;
  moduleId: string;
  enabled: boolean;
  onOpen: (panelId: string) => void;
}): ReactElement {
  const config = form.value;
  const tier = form.view.tier;
  const overview = useQuery(formsOverviewQuery(guildId));

  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<PanelConfig | null>(null);

  const { byId } = useChannelIndex(guildId);

  const ceiling = listCeiling(tier, 'applicationPanels');
  const full = config.panels.length >= ceiling;
  const overLimit = checkListLimit(tier, 'applicationPanels', config.panels.length);
  const noForms = config.forms.length === 0;

  const duplicate = (panel: PanelConfig): void => {
    const id = uniqueId(slugify(`${panel.id}-copy`, PANEL_ID_MAX), panelIds(config), PANEL_ID_MAX);
    form.setValue((current) => ({
      ...current,
      panels: [
        ...current.panels,
        { ...structuredClone(panel), id, name: `${panel.name} copy`.slice(0, NAME_MAX) },
      ],
    }));
    onOpen(id);
  };

  return (
    <Section>
      <CollectionHeader
        title="Panels"
        used={config.panels.length}
        ceiling={ceiling}
        limitLabel={LIMIT_LABELS.applicationPanels}
        actions={
          <Button
            tone="primary"
            icon="plus"
            disabled={full || noForms}
            title={full ? ceilingNote(tier, 'applicationPanels') : undefined}
            onClick={() => setCreating(true)}
          >
            Create panel
          </Button>
        }
      />

      {!overLimit.ok ? (
        <StatusBanner tone="warning" title="Too many panels">
          {overLimit.humanReason}
        </StatusBanner>
      ) : null}

      {config.panels.length === 0 ? (
        <EmptyState
          icon="megaphone"
          title="No panels yet"
          inset
          actions={
            noForms ? undefined : (
              <Button tone="primary" icon="plus" disabled={full} onClick={() => setCreating(true)}>
                Create panel
              </Button>
            )
          }
        >
          {noForms
            ? NO_FORMS
            : 'A panel is a message with a button for each form. Members press one to apply.'}
        </EmptyState>
      ) : (
        <Rows>
          {config.panels.map((panel, index) => (
            <PanelRow
              // biome-ignore lint/suspicious/noArrayIndexKey: two drafts may briefly share an id, so position is the stable key
              key={index}
              form={form}
              panel={panel}
              index={index}
              guildId={guildId}
              moduleId={moduleId}
              enabled={enabled}
              overview={overview.data?.forms}
              channel={panel.channelId === undefined ? undefined : byId.get(panel.channelId)}
              duplicateDisabled={full}
              onEdit={() => onOpen(panel.id)}
              onDuplicate={() => duplicate(panel)}
              onDelete={() => setDeleting(panel)}
            />
          ))}
        </Rows>
      )}

      <CreatePanelDialog
        open={creating}
        taken={panelIds(config)}
        onClose={() => setCreating(false)}
        onCreate={(id, name) => {
          const formIds = config.forms
            .filter((entry) => !entry.archived)
            .slice(0, PANEL_BUTTON_FORMS_MAX)
            .map((entry) => entry.id);
          const seeded = formIds.length > 0 ? formIds : config.forms.slice(0, 1).map((f) => f.id);

          form.setValue((current) => ({
            ...current,
            panels: [
              ...current.panels,
              {
                id,
                name,
                title: 'Applications',
                body: PANEL_BODY_DEFAULT,
                formIds: seeded,
                style: 'buttons',
                showMine: true,
              },
            ],
          }));
          setCreating(false);
          onOpen(id);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        danger
        icon="trash"
        title={`Delete ${deleting?.name ?? 'panel'}?`}
        confirmLabel="Delete panel"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting === null) return;
          form.setValue((current) => ({
            ...current,
            panels: current.panels.filter((candidate) => candidate.id !== deleting.id),
          }));
          setDeleting(null);
        }}
      >
        Messages already posted from this panel stay in their channels. Their buttons keep opening
        the forms until you delete the messages in Discord.
      </ConfirmDialog>
    </Section>
  );
}

function PanelRow({
  form,
  panel,
  index,
  guildId,
  moduleId,
  enabled,
  overview,
  channel,
  duplicateDisabled,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  form: ApplicationsForm;
  panel: PanelConfig;
  index: number;
  guildId: string;
  moduleId: string;
  enabled: boolean;
  overview: readonly FormEntry[] | undefined;
  channel: GuildChannel | undefined;
  duplicateDisabled: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}): ReactElement {
  const listed = panelForms(form.value, panel);

  const post = useMutation({
    mutationFn: () => postModulePanel({ data: { guildId, moduleId, panelId: panel.id } }),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: the panel id is the trigger, not an input
  useEffect(() => {
    post.reset();
  }, [panel.id]);

  const refusal = panelRefusal({ panel, enabled, dirty: form.dirty, overview });
  const idError = form.errorAt(`panels.${index}.id`);

  const phase: AsyncPhase = post.isPending
    ? 'working'
    : post.isError
      ? 'failed'
      : post.isSuccess
        ? 'requested'
        : 'idle';

  const style = PANEL_STYLE_OPTIONS.find((option) => option.value === panel.style)?.label;

  return (
    <div>
      <CollectionStaticRow
        icon="megaphone"
        title={panel.name}
        badge={<Badge tone="neutral">{style ?? panel.style}</Badge>}
        meta={
          <>
            {panel.channelId === undefined ? (
              <Badge tone="warning">No channel</Badge>
            ) : (
              <ChannelName channel={channel} id={panel.channelId} guildId={guildId} />
            )}
            <span>
              {listed.length} {listed.length === 1 ? 'form' : 'forms'}
            </span>
          </>
        }
        aside={
          <>
            <AsyncOperationStatus
              phase={phase}
              workingLabel="Posting…"
              requestedLabel={ASKED}
              failedLabel={
                post.error ? failureText(post.error, 'Couldn’t post the panel') : undefined
              }
            />
            <Button
              size="sm"
              disabled={refusal !== undefined}
              busy={post.isPending}
              onClick={() => post.mutate()}
            >
              Post
            </Button>
            <Button size="sm" onClick={onEdit}>
              Edit
            </Button>
            <MenuButton
              label={`More actions for ${panel.name}`}
              actions={[
                {
                  id: 'duplicate',
                  label: 'Duplicate',
                  icon: 'clipboard-text',
                  disabled: duplicateDisabled,
                  onSelect: onDuplicate,
                },
                { id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: onDelete },
              ]}
            />
          </>
        }
      />

      {idError !== undefined ? (
        <p className="row-error applications-row-note" role="alert">
          {idError}
        </p>
      ) : null}
      {refusal !== undefined ? <p className="applications-row-note">{refusal}</p> : null}
    </div>
  );
}

function CreatePanelDialog({
  open,
  taken,
  onClose,
  onCreate,
}: {
  open: boolean;
  taken: ReadonlySet<string>;
  onClose: () => void;
  onCreate: (id: string, name: string) => void;
}): ReactElement {
  const [name, setName] = useState('Applications');
  const [id, setId] = useState('');
  const [touched, setTouched] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName('Applications');
      setId('');
      setTouched(false);
    }
  }

  const proposed = touched
    ? id.trim()
    : uniqueId(slugify(name, PANEL_ID_MAX, 'panel'), taken, PANEL_ID_MAX);
  const nameError = name.trim() === '' ? 'A panel needs a name.' : undefined;
  const idError = idProblem(proposed, taken, 'panel');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create panel"
      size="compact"
      icon="megaphone"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            disabled={nameError !== undefined || idError !== undefined}
            onClick={() => onCreate(proposed, name.trim())}
          >
            Create panel
          </Button>
        </>
      }
    >
      <Field label="Name" error={nameError}>
        {(props) => (
          <TextInput
            {...props}
            width="full"
            maxLength={NAME_MAX}
            invalid={nameError !== undefined}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        )}
      </Field>

      <Field label="ID" hint={ID_HINT} error={idError}>
        {(props) => (
          <TextInput
            {...props}
            width="lg"
            className="mono"
            spellCheck={false}
            maxLength={PANEL_ID_MAX}
            invalid={idError !== undefined}
            value={proposed}
            onChange={(event) => {
              setTouched(true);
              setId(slugTyping(event.currentTarget.value, PANEL_ID_MAX));
            }}
          />
        )}
      </Field>
    </Dialog>
  );
}
