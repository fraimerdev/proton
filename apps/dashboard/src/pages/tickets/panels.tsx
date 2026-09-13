import { checkListLimit, LIMIT_LABELS } from '@proton/core';
import { blankPanel, PANEL_ID_MAX, type TicketPanel, typesOf } from '@proton/module-tickets/config';
import { useMutation } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ChannelName, useChannelIndex } from '../../components/discord/channel-picker.tsx';
import { CollectionHeader, CollectionStaticRow } from '../../components/ui/collection.tsx';
import { Badge, Button, Chip, Field, TextInput } from '../../components/ui/controls.tsx';
import {
  AsyncOperationStatus,
  type AsyncPhase,
  EmptyState,
  StatusBanner,
} from '../../components/ui/feedback.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { Dialog, MenuButton } from '../../components/ui/overlay.tsx';
import type { GuildChannel } from '../../lib/discord.ts';
import { saveFailure } from '../../lib/errors.ts';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import { postModulePanel } from '../../server/modules.ts';
import { useTicketNav } from './nav.ts';
import { noTypesReason } from './panel-preview.ts';
import {
  duplicateIds,
  PANEL_STYLE_OPTIONS,
  panelIds,
  setPanels,
  slugify,
  type TicketsForm,
  uniqueSlug,
} from './shape.ts';

const NAME_MAX = 64;
const SELECT_TYPES_MAX = 25;

const EMPTY = 'Create a panel for members to open tickets from.';

const ID_HINT = 'Letters, digits, dots, dashes and underscores. It cannot be changed later.';

const ID_TAKEN = 'Another panel already has this ID.';

const ID_SHAPE =
  'a panel id is letters, digits, dots, dashes and underscores, starting with a letter or digit.';

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

const DIRTY = 'Save your changes first. Posting uses the last saved version.';

const MODULE_OFF =
  'Tickets is switched off in this server, so posting this would put a message nobody can use in ' +
  'a channel. Switch it on first.';

const ASKED =
  'Asked Proton to post it. Check the channel in Discord to confirm it appeared. Each post adds a ' +
  'new message.';

export function PanelsArea({
  form,
  guildId,
  moduleId,
  enabled,
}: {
  form: TicketsForm;
  guildId: string;
  moduleId: string;
  enabled: boolean;
}): ReactElement {
  const config = form.value;
  const tier = form.view.tier;
  const go = useTicketNav(guildId, moduleId);

  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TicketPanel | null>(null);

  const { byId } = useChannelIndex(guildId);

  const ceiling = listCeiling(tier, 'ticketPanels');
  const full = config.panels.length >= ceiling;
  const overLimit = checkListLimit(tier, 'ticketPanels', config.panels.length);
  const clashes = duplicateIds(config.panels);

  const duplicate = (panel: TicketPanel): void => {
    const id = uniqueSlug(`${panel.id}-copy`, panelIds(config), PANEL_ID_MAX);
    setPanels(form, [...config.panels, { ...structuredClone(panel), id }]);
    go({ id });
  };

  return (
    <Section>
      <CollectionHeader
        title="Panels"
        used={config.panels.length}
        ceiling={ceiling}
        limitLabel={LIMIT_LABELS.ticketPanels}
        actions={
          <Button
            tone="primary"
            icon="plus"
            disabled={full}
            title={full ? ceilingNote(tier, 'ticketPanels') : undefined}
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
        <EmptyState icon="megaphone" title="No panels" inset>
          {EMPTY}
        </EmptyState>
      ) : (
        <Rows>
          {config.panels.map((panel, index) => (
            <PanelRow
              // biome-ignore lint/suspicious/noArrayIndexKey: a panel's position is stable and two drafts may briefly share an id
              key={index}
              panel={panel}
              form={form}
              guildId={guildId}
              moduleId={moduleId}
              enabled={enabled}
              overLimitReason={overLimit.ok ? undefined : overLimit.humanReason}
              idError={
                clashes.has(index)
                  ? 'two panels cannot share an id — a button would not know which one it meant.'
                  : form.errorAt(`panels.${index}.id`)
              }
              channel={byId.get(panel.channelId)}
              onEdit={() => go({ id: panel.id })}
              onDuplicate={() => duplicate(panel)}
              onDelete={() => setDeleting(panel)}
              duplicateDisabled={full}
            />
          ))}
        </Rows>
      )}

      <CreatePanelDialog
        open={creating}
        taken={panelIds(config)}
        onClose={() => setCreating(false)}
        onCreate={(id, name) => {
          const seeded =
            config.types.length <= SELECT_TYPES_MAX ? config.types.map((type) => type.id) : [];

          setPanels(form, [
            ...config.panels,
            { ...blankPanel(config.panels.length, seeded), id, name },
          ]);
          setCreating(false);
          go({ id });
        }}
      />

      {deleting !== null ? (
        <Dialog
          open
          onClose={() => setDeleting(null)}
          title={`Delete ${deleting.name}?`}
          footer={
            <>
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button
                tone="danger"
                onClick={() => {
                  setPanels(
                    form,
                    config.panels.filter((candidate) => candidate.id !== deleting.id),
                  );
                  setDeleting(null);
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p className="text-secondary text-sm">
            Messages already posted from this panel stay in their channels, but their buttons stop
            working. Delete them in Discord.
          </p>
        </Dialog>
      ) : null}
    </Section>
  );
}

function PanelRow({
  panel,
  form,
  guildId,
  moduleId,
  enabled,
  overLimitReason,
  idError,
  channel,
  onEdit,
  onDuplicate,
  onDelete,
  duplicateDisabled,
}: {
  panel: TicketPanel;
  form: TicketsForm;
  guildId: string;
  moduleId: string;
  enabled: boolean;
  overLimitReason: string | undefined;
  idError: string | undefined;
  channel: GuildChannel | undefined;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  duplicateDisabled: boolean;
}): ReactElement {
  const carried = typesOf(form.value, panel);

  const post = useMutation({
    mutationFn: () => postModulePanel({ data: { guildId, moduleId, panelId: panel.id } }),
  });

  const refusal = !enabled
    ? MODULE_OFF
    : panel.channelId === ''
      ? `'${panel.name}' has no channel to go in yet. Pick one and save, then post it.`
      : carried.length === 0
        ? noTypesReason(panel)
        : overLimitReason !== undefined
          ? overLimitReason
          : form.dirty
            ? DIRTY
            : undefined;

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
        badge={<Chip className="mono">{panel.id}</Chip>}
        meta={
          <>
            {panel.channelId === '' ? (
              <Badge tone="warning">No channel</Badge>
            ) : (
              <ChannelName channel={channel} id={panel.channelId} guildId={guildId} />
            )}
            <Badge tone="neutral">{style}</Badge>
            {carried.length === 0 ? (
              <Badge tone="warning">No ticket types</Badge>
            ) : (
              <Badge tone="neutral">
                {carried.length} {carried.length === 1 ? 'ticket type' : 'ticket types'}
              </Badge>
            )}
          </>
        }
        aside={
          <>
            <AsyncOperationStatus
              phase={phase}
              workingLabel="Posting…"
              requestedLabel={ASKED}
              failedLabel={post.error ? saveFailure(post.error, 'Panel was not posted') : undefined}
            />
            <Button
              size="sm"
              disabled={refusal !== undefined}
              title={refusal}
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

      {idError !== undefined ? <p className="row-error tickets-row-error">{idError}</p> : null}
      {refusal !== undefined ? <p className="tickets-row-note">{refusal}</p> : null}
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
}): ReactElement | null {
  const [name, setName] = useState('Support');
  const [id, setId] = useState('');
  const [touchedId, setTouchedId] = useState(false);

  if (!open) return null;

  const proposed = touchedId ? id : slugify(name, PANEL_ID_MAX);
  const idError = !SLUG.test(proposed) ? ID_SHAPE : taken.has(proposed) ? ID_TAKEN : undefined;
  const nameError = name.trim() === '' ? 'Panel needs a name.' : undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create panel"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            disabled={idError !== undefined || nameError !== undefined}
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
              className="mono"
              spellCheck={false}
              maxLength={PANEL_ID_MAX}
              invalid={idError !== undefined}
              value={proposed}
              onChange={(event) => {
                setTouchedId(true);
                setId(event.currentTarget.value);
              }}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
