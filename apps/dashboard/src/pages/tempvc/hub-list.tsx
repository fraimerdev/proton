import { blankHub } from '@proton/module-tempvc/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  CHANNEL_TYPE,
  ChannelName,
  ChannelPicker,
} from '../../components/discord/channel-picker.tsx';
import {
  CollectionButtonRow,
  CollectionHeader,
  MetaSeparator,
} from '../../components/ui/collection.tsx';
import { Badge, Button, SearchField } from '../../components/ui/controls.tsx';
import { EmptyState, Spinner } from '../../components/ui/feedback.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import { channelsQuery } from '../../lib/queries.ts';
import { DUPLICATE_HUB, PRIVACY_SHORT, setHubs, type TempVcForm } from './shape.ts';

const SEARCH_FROM = 8;

const EMPTY = 'Add a voice channel members join to get a channel of their own.';

export function HubList({
  form,
  guildId,
  query,
  onQuery,
  onOpen,
}: {
  form: TempVcForm;
  guildId: string;
  query: string;
  onQuery: (query: string) => void;
  onOpen: (channelId: string) => void;
}): ReactElement {
  const hubs = form.value.hubs;
  const [adding, setAdding] = useState(false);

  const ceiling = listCeiling(form.view.tier, 'tempVcHubs');
  const atCeiling = hubs.length >= ceiling;

  const { data: channels, isPending: channelsPending } = useQuery(channelsQuery(guildId));
  const channelById = new Map((channels ?? []).map((channel) => [channel.id, channel]));

  const searchable = hubs.length > SEARCH_FROM;
  const needle = searchable ? query.trim().toLowerCase() : '';

  const broken = new Set<number>();
  for (const path of form.errors.keys()) {
    const at = /^hubs\.(\d+)\./.exec(path)?.[1];
    if (at !== undefined) broken.add(Number(at));
  }

  const shown = hubs
    .map((hub, index) => ({ hub, index }))
    .filter(({ hub }) => {
      if (needle === '') return true;

      const name = channelById.get(hub.channelId)?.name ?? hub.channelId;
      const category =
        hub.categoryId === undefined ? '' : (channelById.get(hub.categoryId)?.name ?? '');

      return (
        name.toLowerCase().includes(needle) ||
        category.toLowerCase().includes(needle) ||
        hub.nameTemplate.toLowerCase().includes(needle)
      );
    });

  const add = (channelId: string): void => {
    setHubs(form, [...hubs, { ...blankHub(), channelId }]);
    setAdding(false);
    onOpen(channelId);
  };

  return (
    <Section>
      <CollectionHeader
        title="Creator channels"
        used={hubs.length}
        ceiling={ceiling}
        limitLabel="creator channels"
        actions={
          <>
            {searchable ? (
              <SearchField
                value={query}
                label="Search creator channels"
                placeholder="Search creator channels…"
                onChange={onQuery}
              />
            ) : null}
            <Button
              tone="primary"
              icon="plus"
              disabled={atCeiling}
              title={atCeiling ? ceilingNote(form.view.tier, 'tempVcHubs') : undefined}
              onClick={() => setAdding(true)}
            >
              Add creator channel
            </Button>
          </>
        }
      />

      {hubs.length === 0 ? (
        <EmptyState
          icon="speaker-high"
          title="No creator channels"
          inset
          actions={
            <Button tone="primary" icon="plus" onClick={() => setAdding(true)}>
              Add creator channel
            </Button>
          }
        >
          {EMPTY}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon="magnifying-glass" title="No matching creator channels" inset>
          Search looks at channel names, categories and name templates.
        </EmptyState>
      ) : (
        <Rows>
          {shown.map(({ hub, index }) => (
            <CollectionButtonRow
              key={hub.channelId}
              icon="speaker-high"
              title={
                channelsPending ? (
                  <Spinner label="Loading channel" />
                ) : (
                  <ChannelName channel={channelById.get(hub.channelId)} id={hub.channelId} />
                )
              }
              badge={
                <>
                  {broken.has(index) ? <Badge tone="danger">Needs fixing</Badge> : null}
                  {hub.enabled ? null : <Badge tone="neutral">Off</Badge>}
                </>
              }
              meta={
                <>
                  {hub.categoryId === undefined ? (
                    <span className="text-muted">No category</span>
                  ) : channelsPending ? (
                    <Spinner label="Loading category" />
                  ) : (
                    <ChannelName channel={channelById.get(hub.categoryId)} id={hub.categoryId} />
                  )}
                  <MetaSeparator />
                  {PRIVACY_SHORT[hub.privacy]}
                  <MetaSeparator />
                  <span className="truncate">{hub.nameTemplate}</span>
                </>
              }
              aside={
                hub.maxChannelsPerUser > 1 ? `${hub.maxChannelsPerUser} per member` : undefined
              }
              onSelect={() => onOpen(hub.channelId)}
            />
          ))}
        </Rows>
      )}

      <AddHubDialog
        open={adding}
        guildId={guildId}
        taken={new Set(hubs.map((hub) => hub.channelId))}
        onClose={() => setAdding(false)}
        onAdd={add}
      />
    </Section>
  );
}

function AddHubDialog({
  open,
  guildId,
  taken,
  onClose,
  onAdd,
}: {
  open: boolean;
  guildId: string;
  taken: ReadonlySet<string>;
  onClose: () => void;
  onAdd: (channelId: string) => void;
}): ReactElement | null {
  const [picked, setPicked] = useState<string | null>(null);

  if (!open) return null;

  const duplicate = picked !== null && taken.has(picked);

  const close = (): void => {
    setPicked(null);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Add creator channel"
      description="Nothing is saved until you save changes."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            tone="primary"
            disabled={picked === null || duplicate}
            onClick={() => {
              if (picked === null || duplicate) return;
              setPicked(null);
              onAdd(picked);
            }}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Creator channel</span>
        <ChannelPicker
          guildId={guildId}
          label="Creator channel"
          placeholder="Choose a voice channel"
          types={[CHANNEL_TYPE.voice]}
          allowNone={false}
          invalid={duplicate}
          width="100%"
          value={picked}
          onChange={setPicked}
        />
        {duplicate ? (
          <span className="field-error">{DUPLICATE_HUB}</span>
        ) : (
          <span className="field-hint">
            Members who join this channel get a voice channel of their own and are moved into it.
          </span>
        )}
      </div>
    </Dialog>
  );
}
