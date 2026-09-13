import { checkListLimit, LIMIT_LABELS } from '@proton/core';
import { type AppealPanel, PANEL_ID_MAX, reviewChannelFor } from '@proton/module-appeals/config';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ChannelName, useChannelIndex } from '../../components/discord/channel-picker.tsx';
import {
  CollectionHeader,
  CollectionStaticRow,
  MetaSeparator,
} from '../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  Chip,
  Field,
  SearchField,
  TextInput,
} from '../../components/ui/controls.tsx';
import { EmptyState, StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { Dialog, MenuButton } from '../../components/ui/overlay.tsx';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import {
  type AppealsForm,
  duplicatePanelId,
  newPanel,
  OUTCOME_CHIP,
  PANEL_NAME_MAX,
  panelIds,
  panelTitle,
  slugify,
} from './shape.ts';

const EMPTY =
  'Create a form, then choose it in Honeypot. Only Honeypot sends appeal links, and only when ' +
  'its action is Ban.';

const SEARCH_FROM = 8;

const ID_HINT = 'Honeypot points at this form by its ID. It cannot be changed later.';

function duplicateId(id: string): string {
  return `two forms are both called '${id}'. A honeypot points at one by its id.`;
}

export function FormsArea({
  form,
  guildId,
  onOpen,
}: {
  form: AppealsForm;
  guildId: string;
  onOpen: (panelId: string) => void;
}): ReactElement {
  const config = form.value;
  const tier = form.view.tier;

  const [term, setTerm] = useState('');
  const [creating, setCreating] = useState<{ name: string } | null>(null);
  const [deleting, setDeleting] = useState<AppealPanel | null>(null);

  const { byId } = useChannelIndex(guildId);

  const ceiling = listCeiling(tier, 'appealPanels');
  const full = config.panels.length >= ceiling;
  const overLimit = checkListLimit(tier, 'appealPanels', config.panels.length);

  const needle = term.trim().toLowerCase();
  const shown = config.panels.filter(
    (panel) =>
      needle === '' ||
      panel.name.toLowerCase().includes(needle) ||
      panel.id.toLowerCase().includes(needle),
  );

  const create = (id: string, name: string): void => {
    form.setValue((current) => ({ ...current, panels: [...current.panels, newPanel(id, name)] }));
    setCreating(null);
    onOpen(id);
  };

  const duplicate = (panel: AppealPanel): void => {
    const id = duplicatePanelId(panel, panelIds(config));
    form.setValue((current) => ({
      ...current,
      panels: [...current.panels, { ...structuredClone(panel), id, name: `${panel.name} copy` }],
    }));
    onOpen(id);
  };

  const remove = (panel: AppealPanel): void => {
    form.setValue((current) => ({
      ...current,
      panels: current.panels.filter((candidate) => candidate.id !== panel.id),
    }));
    setDeleting(null);
  };

  return (
    <Section>
      <CollectionHeader
        title="Appeal forms"
        used={config.panels.length}
        ceiling={ceiling}
        limitLabel={LIMIT_LABELS.appealPanels}
        actions={
          <>
            {config.panels.length > SEARCH_FROM ? (
              <SearchField
                value={term}
                onChange={setTerm}
                label="Search appeal forms"
                placeholder="Search appeal forms…"
              />
            ) : null}
            <Button
              tone="primary"
              icon="plus"
              disabled={full}
              title={full ? ceilingNote(tier, 'appealPanels') : undefined}
              onClick={() => setCreating({ name: 'Ban appeal' })}
            >
              Create appeal form
            </Button>
          </>
        }
      />

      {!overLimit.ok ? (
        <StatusBanner tone="warning" title="Too many appeal forms">
          {overLimit.humanReason}
        </StatusBanner>
      ) : null}

      {config.panels.length === 0 ? (
        <EmptyState
          icon="scales"
          title="No appeal forms"
          inset
          actions={
            <Button tone="primary" icon="plus" onClick={() => setCreating({ name: 'Ban appeal' })}>
              Create appeal form
            </Button>
          }
        >
          {EMPTY}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon="magnifying-glass" title="No matching appeal forms" inset />
      ) : (
        <Rows>
          {shown.map((panel) => {
            const index = config.panels.indexOf(panel);
            const routedTo = reviewChannelFor(config, panel);
            const idError = form.errorAt(`panels.${index}.id`);

            return (
              <CollectionStaticRow
                key={panel.id}
                icon="scales"
                title={panelTitle(panel)}
                badge={<Chip className="mono">{panel.id}</Chip>}
                meta={
                  <>
                    {panel.enabled ? null : <Badge>Off</Badge>}
                    <span>
                      {panel.questions.length}{' '}
                      {panel.questions.length === 1 ? 'question' : 'questions'}
                    </span>
                    <MetaSeparator />
                    <span>{OUTCOME_CHIP[panel.onApprove]}</span>
                    <MetaSeparator />
                    {routedTo === undefined ? (
                      <Badge tone="warning">No review channel</Badge>
                    ) : panel.reviewChannelId === undefined ? (
                      <span>Default review channel</span>
                    ) : (
                      <ChannelName channel={byId.get(routedTo)} id={routedTo} guildId={guildId} />
                    )}
                    {idError !== undefined ? (
                      <>
                        <MetaSeparator />
                        <span className="text-danger">{idError}</span>
                      </>
                    ) : null}
                  </>
                }
                aside={
                  <>
                    <Button size="sm" onClick={() => onOpen(panel.id)}>
                      Edit
                    </Button>
                    <MenuButton
                      label={`More actions for ${panelTitle(panel)}`}
                      actions={[
                        {
                          id: 'duplicate',
                          label: 'Duplicate',
                          icon: 'clipboard-text',
                          disabled: full,
                          onSelect: () => duplicate(panel),
                        },
                        {
                          id: 'delete',
                          label: 'Delete',
                          icon: 'trash',
                          danger: true,
                          onSelect: () => setDeleting(panel),
                        },
                      ]}
                    />
                  </>
                }
                className={idError !== undefined ? 'appeals-row-bad' : ''}
              />
            );
          })}
        </Rows>
      )}

      {creating !== null ? (
        <CreateFormDialog
          taken={panelIds(config)}
          initialName={creating.name}
          onClose={() => setCreating(null)}
          onCreate={create}
        />
      ) : null}

      {deleting !== null ? (
        <DeleteFormDialog panel={deleting} onClose={() => setDeleting(null)} onConfirm={remove} />
      ) : null}
    </Section>
  );
}

function CreateFormDialog({
  taken,
  initialName,
  onClose,
  onCreate,
}: {
  taken: ReadonlySet<string>;
  initialName: string;
  onClose: () => void;
  onCreate: (id: string, name: string) => void;
}): ReactElement {
  const [name, setName] = useState(initialName);
  const [id, setId] = useState('');
  const [touched, setTouched] = useState(false);

  const proposed = touched ? id.trim() : slugify(name, PANEL_ID_MAX);

  const nameError = name.trim() === '' ? 'Appeal form needs a name.' : undefined;
  const idError =
    proposed === ''
      ? 'Appeal form needs an ID.'
      : taken.has(proposed)
        ? duplicateId(proposed)
        : undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create appeal form"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            disabled={nameError !== undefined || idError !== undefined}
            onClick={() => onCreate(proposed, name.trim())}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="stack stack-16">
        <Field label="Name" error={nameError}>
          {(props) => (
            <TextInput
              {...props}
              autoFocus
              maxLength={PANEL_NAME_MAX}
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
              className="mono"
              spellCheck={false}
              maxLength={PANEL_ID_MAX}
              invalid={idError !== undefined}
              value={proposed}
              onChange={(event) => {
                setTouched(true);
                setId(event.currentTarget.value);
              }}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function DeleteFormDialog({
  panel,
  onClose,
  onConfirm,
}: {
  panel: AppealPanel;
  onClose: () => void;
  onConfirm: (panel: AppealPanel) => void;
}): ReactElement {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${panelTitle(panel)}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="danger" onClick={() => onConfirm(panel)}>
            Delete
          </Button>
        </>
      }
    >
      <div className="stack stack-12">
        <p className="text-secondary text-sm">
          Honeypot stops offering appeals through <span className="mono">{panel.id}</span>, and
          links already sent show: “The appeal form this link points at no longer exists. Nothing
          you did caused this — the server changed its settings.”
        </p>
        <p className="text-secondary text-sm">
          Appeals already sent through this form stay visible to moderators.
        </p>
      </div>
    </Dialog>
  );
}
