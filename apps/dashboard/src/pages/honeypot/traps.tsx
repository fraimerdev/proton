import { LIMIT_LABELS } from '@proton/core';
import type { HoneypotConfig } from '@proton/module-honeypot/config';
import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  CHANNEL_TYPE,
  ChannelPicker,
  channelIcon,
  useChannelIndex,
} from '../../components/discord/channel-picker.tsx';
import {
  CollectionHeader,
  CollectionStaticRow,
  useRecent,
} from '../../components/ui/collection.tsx';
import { Badge, cx, IconButton, Switch } from '../../components/ui/controls.tsx';
import { EmptyState, Spinner, StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import type { HoneypotForm } from './shape.ts';

const BAIT_TYPES = [CHANNEL_TYPE.text, CHANNEL_TYPE.announcement] as const;

const DUPLICATE =
  'This channel is already a honeypot. Edit the row above instead of adding it twice.';

const UNKNOWN_CHANNEL = 'Channel not found. It may have been deleted or hidden from Proton.';

const EMPTY = 'Add a channel where any message from a member triggers Honeypot.';

export function TrapsArea({
  form,
  guildId,
}: {
  form: HoneypotForm;
  guildId: string;
}): ReactElement {
  const config = form.value;
  const [refused, setRefused] = useState<string | null>(null);
  const [refusals, setRefusals] = useState(0);
  const added = useRecent();
  const flipped = useRecent();

  const { byId, pending } = useChannelIndex(guildId);

  const ceiling = listCeiling(form.view.tier, 'honeypotChannels');
  const full = config.channels.length >= ceiling;

  const setChannels = (next: HoneypotConfig['channels']): void =>
    form.setValue((current) => ({ ...current, channels: next }));

  const add = (channelId: string | null): void => {
    if (channelId === null) return;

    if (config.channels.some((channel) => channel.channelId === channelId)) {
      setRefused(DUPLICATE);
      setRefusals((count) => count + 1);
      return;
    }

    setRefused(null);
    added.mark(`${channelId}:${config.channels.length}`);
    setChannels([...config.channels, { channelId, enabled: true }]);
  };

  return (
    <>
      <Section>
        <CollectionHeader
          title="Bait channels"
          used={config.channels.length}
          ceiling={ceiling}
          limitLabel={LIMIT_LABELS.honeypotChannels}
          actions={
            <ChannelPicker
              guildId={guildId}
              label="Add bait channel"
              placeholder="Add channel"
              allowNone={false}
              disabled={full}
              types={BAIT_TYPES}
              value={null}
              onChange={add}
            />
          }
        />

        {refused !== null ? (
          <p key={refusals} className="row-error honeypot-collection-note motion-fade">
            {refused}
          </p>
        ) : null}

        {config.channels.length > ceiling ? (
          <StatusBanner tone="warning" title="Too many bait channels">
            {ceilingNote(form.view.tier, 'honeypotChannels')}, and this page has{' '}
            {config.channels.length}. Remove {config.channels.length - ceiling} before saving.
          </StatusBanner>
        ) : null}

        {config.channels.length === 0 ? (
          <EmptyState icon="bug" title="No bait channels" inset>
            {EMPTY}
          </EmptyState>
        ) : (
          <Rows>
            {config.channels.map((channel, index) => {
              const known = byId.get(channel.channelId);
              const label = known ? `#${known.name}` : channel.channelId;
              const error = form.errorAt(`channels.${index}.channelId`);
              const row = `${channel.channelId}:${index}`;

              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a duplicate channel id is the one thing the row error below exists for, so the key cannot be the id alone
                <div key={`${channel.channelId}:${index}`} className={added.enter(row)}>
                  <CollectionStaticRow
                    icon={known ? channelIcon(known.type) : pending ? 'hash' : 'prohibit'}
                    title={
                      known ? (
                        `#${known.name}`
                      ) : pending ? (
                        <Spinner label="Loading channel" />
                      ) : (
                        <span className="mono text-muted">{channel.channelId}</span>
                      )
                    }
                    badge={
                      <span
                        key={channel.enabled ? 'armed' : 'paused'}
                        className={cx(
                          'honeypot-state',
                          flipped.has(row) && (channel.enabled ? 'motion-pop' : 'motion-fade'),
                        )}
                      >
                        <Badge tone="neutral">{channel.enabled ? 'Armed' : 'Paused'}</Badge>
                      </span>
                    }
                    meta={
                      known
                        ? (known.parentName ?? undefined)
                        : pending
                          ? undefined
                          : UNKNOWN_CHANNEL
                    }
                    aside={
                      <>
                        <Switch
                          label={`${label} armed`}
                          checked={channel.enabled}
                          onChange={(next) => {
                            flipped.mark(row);
                            setChannels(
                              config.channels.map((current, at) =>
                                at === index ? { ...current, enabled: next } : current,
                              ),
                            );
                          }}
                        />
                        <IconButton
                          icon="trash"
                          tone="ghost"
                          size="sm"
                          label={`Remove ${label}`}
                          onClick={() =>
                            setChannels(config.channels.filter((_, at) => at !== index))
                          }
                        />
                      </>
                    }
                  />
                  {error !== undefined ? (
                    <p className="row-error honeypot-row-error">{error}</p>
                  ) : null}
                </div>
              );
            })}
          </Rows>
        )}
      </Section>

      <Section label="Coverage">
        <Rows>
          <SettingRow
            title="Include threads"
            description="Messages in threads under a bait channel trigger Honeypot too."
          >
            <Switch
              label="Include threads"
              checked={config.includeThreads}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, includeThreads: next }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}
