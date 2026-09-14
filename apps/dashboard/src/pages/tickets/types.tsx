import { checkListLimit, LIMIT_LABELS, parseComponentEmoji } from '@proton/core';
import {
  blankType,
  PRIORITY_LABELS,
  type TicketType,
  TYPE_ID_MAX,
} from '@proton/module-tickets/config';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ChannelName, useChannelIndex } from '../../components/discord/channel-picker.tsx';
import { EmojiGlyph } from '../../components/discord/emoji-picker.tsx';
import { useModuleNavigate } from '../../components/module/route.tsx';
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
  duplicateIds,
  panelsCarrying,
  priorityHex,
  setTypes,
  slugify,
  type TicketsForm,
  typeIds,
  uniqueSlug,
} from './shape.ts';

const NAME_MAX = 64;

const EMPTY = 'Create a ticket type, then add it to a panel.';

const ID_HINT = 'Letters, digits, dots, dashes and underscores. It cannot be changed later.';

const ID_TAKEN = 'Another ticket type already has this ID.';

const ID_SHAPE =
  'a ticket type id is letters, digits, dots, dashes and underscores, starting with a letter or digit.';

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

function stateChips(
  type: TicketType,
  onPanels: number,
): readonly { key: string; label: string; warning: boolean }[] {
  const chips: { key: string; label: string; warning: boolean }[] = [];

  if (type.form.length > 0) {
    chips.push({
      key: 'form',
      label: `${type.form.length} ${type.form.length === 1 ? 'question' : 'questions'}`,
      warning: false,
    });
  }
  if (type.claimMode === 'off') chips.push({ key: 'claim', label: 'No claiming', warning: false });
  if (type.transcript === 'off') {
    chips.push({ key: 'transcript', label: 'No transcript', warning: false });
  }
  if (type.captureMessages) {
    chips.push({ key: 'capture', label: 'Captures messages', warning: false });
  }
  if (type.autoCloseAfter !== undefined) {
    chips.push({ key: 'close', label: `Auto-closes after ${type.autoCloseAfter}`, warning: false });
  }
  if (type.autoDeleteAfter !== undefined) {
    chips.push({ key: 'delete', label: `Deletes after ${type.autoDeleteAfter}`, warning: false });
  }
  if (onPanels === 0) chips.push({ key: 'orphan', label: 'No panel', warning: true });

  return chips;
}

export function TypesArea({
  form,
  guildId,
  moduleId,
}: {
  form: TicketsForm;
  guildId: string;
  moduleId: string;
}): ReactElement {
  const config = form.value;
  const tier = form.view.tier;
  const go = useModuleNavigate(guildId, moduleId);

  const [term, setTerm] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TicketType | null>(null);

  const { byId } = useChannelIndex(guildId);

  const ceiling = listCeiling(tier, 'ticketTypes');
  const full = config.types.length >= ceiling;
  const overLimit = checkListLimit(tier, 'ticketTypes', config.types.length);
  const clashes = duplicateIds(config.types);

  const needle = term.trim().toLowerCase();
  const shown = config.types.filter(
    (type) =>
      needle === '' ||
      type.name.toLowerCase().includes(needle) ||
      type.id.toLowerCase().includes(needle) ||
      (type.description ?? '').toLowerCase().includes(needle),
  );

  const duplicate = (type: TicketType): void => {
    const id = uniqueSlug(`${type.id}-copy`, typeIds(config), TYPE_ID_MAX);
    setTypes(form, [...config.types, { ...structuredClone(type), id }]);
    go({ id });
  };

  const remove = (type: TicketType): void => {
    form.setValue((current) => ({
      ...current,
      types: current.types.filter((candidate) => candidate.id !== type.id),
      panels: current.panels.map((panel) => ({
        ...panel,
        typeIds: panel.typeIds.filter((candidate) => candidate !== type.id),
      })),
    }));
    setDeleting(null);
  };

  return (
    <Section>
      <CollectionHeader
        title="Ticket types"
        used={config.types.length}
        ceiling={ceiling}
        limitLabel={LIMIT_LABELS.ticketTypes}
        actions={
          <>
            <SearchField
              value={term}
              onChange={setTerm}
              label="Search ticket types"
              placeholder="Search ticket types…"
            />
            <Button
              tone="primary"
              icon="plus"
              disabled={full}
              title={full ? ceilingNote(tier, 'ticketTypes') : undefined}
              onClick={() => setCreating(true)}
            >
              Create ticket type
            </Button>
          </>
        }
      />

      {!overLimit.ok ? (
        <StatusBanner tone="warning" title="Too many ticket types">
          {overLimit.humanReason}
        </StatusBanner>
      ) : null}

      {config.types.length === 0 ? (
        <EmptyState icon="ticket" title="No ticket types" inset>
          {EMPTY}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon="magnifying-glass" title="No matching ticket types" inset />
      ) : (
        <Rows>
          {shown.map((type) => {
            const index = config.types.indexOf(type);
            const carried = panelsCarrying(config, type.id);
            const chips = stateChips(type, carried.length);
            const category = type.categoryId === undefined ? undefined : byId.get(type.categoryId);
            const emoji = parseComponentEmoji(type.emoji);
            const clash = clashes.has(index);
            const idError = clash
              ? 'two ticket types cannot share an id — a button would not know which one it meant.'
              : form.errorAt(`types.${index}.id`);

            return (
              <div key={type.id}>
                <CollectionStaticRow
                  icon={emoji ? undefined : 'ticket'}
                  glyph={emoji ? <EmojiGlyph emoji={emoji} size={18} /> : undefined}
                  title={type.name}
                  badge={<Chip className="mono">{type.id}</Chip>}
                  meta={
                    <>
                      <Chip colour={priorityHex(type.defaultPriority)}>
                        {PRIORITY_LABELS[type.defaultPriority]}
                      </Chip>
                      {type.categoryId === undefined ? (
                        <span>No category</span>
                      ) : (
                        <ChannelName channel={category} id={type.categoryId} guildId={guildId} />
                      )}
                      {type.description !== undefined && type.description !== '' ? (
                        <>
                          <MetaSeparator />
                          <span className="truncate">{type.description}</span>
                        </>
                      ) : null}
                      {chips.map((chip) => (
                        <Badge key={chip.key} tone={chip.warning ? 'warning' : 'neutral'}>
                          {chip.label}
                        </Badge>
                      ))}
                    </>
                  }
                  aside={
                    <>
                      <Button size="sm" onClick={() => go({ id: type.id })}>
                        Edit
                      </Button>
                      <MenuButton
                        label={`More actions for ${type.name}`}
                        actions={[
                          {
                            id: 'duplicate',
                            label: 'Duplicate',
                            icon: 'clipboard-text',
                            disabled: full,
                            onSelect: () => duplicate(type),
                          },
                          {
                            id: 'delete',
                            label: 'Delete',
                            icon: 'trash',
                            danger: true,
                            onSelect: () => setDeleting(type),
                          },
                        ]}
                      />
                    </>
                  }
                />
                {idError !== undefined ? (
                  <p className="row-error tickets-row-error">{idError}</p>
                ) : null}
              </div>
            );
          })}
        </Rows>
      )}

      <CreateTypeDialog
        open={creating}
        taken={typeIds(config)}
        onClose={() => setCreating(false)}
        onCreate={(id, name) => {
          setTypes(form, [...config.types, { ...blankType(config.types.length), id, name }]);
          setCreating(false);
          go({ id });
        }}
      />

      <DeleteTypeDialog
        type={deleting}
        panelNames={deleting === null ? [] : panelsCarrying(config, deleting.id).map((p) => p.name)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
      />
    </Section>
  );
}

function CreateTypeDialog({
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

  const proposed = touchedId ? id : slugify(name, TYPE_ID_MAX);
  const idError = !SLUG.test(proposed) ? ID_SHAPE : taken.has(proposed) ? ID_TAKEN : undefined;
  const nameError = name.trim() === '' ? 'Ticket type needs a name.' : undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create ticket type"
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
              maxLength={TYPE_ID_MAX}
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

function DeleteTypeDialog({
  type,
  panelNames,
  onClose,
  onConfirm,
}: {
  type: TicketType | null;
  panelNames: readonly string[];
  onClose: () => void;
  onConfirm: (type: TicketType) => void;
}): ReactElement | null {
  if (type === null) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${type.name}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="danger" onClick={() => onConfirm(type)}>
            Delete
          </Button>
        </>
      }
    >
      <div className="stack stack-12">
        <p className="text-secondary text-sm">
          Tickets already opened with this type are kept, and the queue shows the type’s ID instead
          of its name.
        </p>
        {panelNames.length > 0 ? (
          <p className="text-warning text-sm">
            Still offered on {panelNames.length} panel{panelNames.length === 1 ? '' : 's'}:{' '}
            {panelNames.join(', ')}. It disappears from each one the next time that panel is posted.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
