import {
  COUNT_PLACEHOLDER,
  type Counter,
  type CounterSource,
  TEMPLATE_MAX,
} from '@proton/module-counters/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import {
  CHANNEL_TYPE,
  ChannelPicker,
  channelIcon,
} from '../../components/discord/channel-picker.tsx';
import { Button, SegmentedControl, TextInput } from '../../components/ui/controls.tsx';
import type { IconName } from '../../components/ui/icon.tsx';
import { ActionRow, Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { ConfirmDialog } from '../../components/ui/overlay.tsx';
import { channelsQuery } from '../../lib/queries.ts';
import {
  CHANNEL_TAKEN,
  type CountersForm,
  channelTaken,
  counterIssues,
  EMPTY_TEMPLATE,
  NamePreview,
  SOURCE_OPTIONS,
  setCounters,
  withChannel,
} from './shape.tsx';

const DESTINATIONS = [
  CHANNEL_TYPE.voice,
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.category,
  CHANNEL_TYPE.stage,
] as const;

const PROTON_MAKES =
  'Proton creates a voice channel at the top of the channel list. Without Manage Roles, the ' +
  'counter still works, but members can join the channel.';

const ID_EXPLAINS =
  'Proton links the channel it creates for this counter to this ID. Changing the ID would leave ' +
  'the old channel behind and create a new one.';

const REMOVE_EXPLAINS = 'Proton stops refreshing the channel but does not delete it.';

export function CounterDetail({
  form,
  guildId,
  index,
  counter,
  onRemoved,
}: {
  form: CountersForm;
  guildId: string;
  index: number;
  counter: Counter;
  onRemoved: () => void;
}): ReactElement {
  const [removing, setRemoving] = useState(false);

  const counters = form.value.counters;

  const { data: channels } = useQuery({
    ...channelsQuery(guildId),
    enabled: counter.channelId !== undefined,
  });

  const channel = channels?.find((candidate) => candidate.id === counter.channelId);

  const change = (next: Counter): void =>
    setCounters(
      form,
      counters.map((current, at) => (at === index ? next : current)),
    );

  const issues = counterIssues(counter);
  const at = (field: string): string | undefined => form.errorAt(`counters.${index}.${field}`);

  const templateError =
    counter.template === '' ? EMPTY_TEMPLATE : (issues.get('template') ?? at('template'));

  const channelError = channelTaken(counters, index) ? CHANNEL_TAKEN : at('channelId');

  const previewIcon: IconName =
    counter.channelId === undefined ? 'speaker-high' : channel ? channelIcon(channel.type) : 'hash';

  return (
    <>
      <Section label="Count">
        <Rows>
          <SettingRow
            title="What to count"
            description="Roles exclude @everyone. Channels exclude categories and threads."
          >
            <SegmentedControl
              label="What to count"
              options={SOURCE_OPTIONS}
              value={counter.source}
              onChange={(source: CounterSource) => change({ ...counter, source })}
            />
          </SettingRow>

          <SettingRow
            title="Name template"
            description={
              <>
                Put <span className="mono">{COUNT_PLACEHOLDER}</span> where the number should go.
              </>
            }
            stacked
            error={templateError}
          >
            <div className="stack stack-12">
              <TextInput
                width="lg"
                aria-label="Name template"
                spellCheck={false}
                maxLength={TEMPLATE_MAX}
                invalid={templateError !== undefined}
                value={counter.template}
                onChange={(event) => change({ ...counter, template: event.currentTarget.value })}
              />

              <div className="field">
                <span className="field-label">Channel name</span>
                <NamePreview template={counter.template} icon={previewIcon} />
              </div>
            </div>
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Location">
        <Rows>
          <SettingRow
            title="Channel"
            description="Discord changes text channel names to lowercase, with dashes for spaces."
            error={channelError}
            note={counter.channelId === undefined ? PROTON_MAKES : undefined}
          >
            <ChannelPicker
              guildId={guildId}
              label="Channel"
              types={DESTINATIONS}
              noneLabel="Create a channel"
              placeholder="Create a channel"
              invalid={channelError !== undefined}
              value={counter.channelId}
              onChange={(next) => change(withChannel(counter, next))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Identity">
        <Rows>
          <SettingRow
            title="Counter ID"
            description={ID_EXPLAINS}
            error={issues.get('id') ?? at('id')}
          >
            <CounterId id={counter.id} />
          </SettingRow>
        </Rows>
      </Section>

      <Section>
        <Rows>
          <ActionRow title="Remove counter" description={REMOVE_EXPLAINS}>
            <Button tone="danger-quiet" icon="trash" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </ActionRow>
        </Rows>
      </Section>

      <ConfirmDialog
        open={removing}
        danger
        title="Remove counter?"
        confirmLabel="Remove"
        onClose={() => setRemoving(false)}
        onConfirm={() => {
          setCounters(
            form,
            counters.filter((_, position) => position !== index),
          );
          setRemoving(false);
          onRemoved();
        }}
      >
        The channel stays in Discord as it is. Delete it there if you no longer need it.
      </ConfirmDialog>
    </>
  );
}

function CounterId({ id }: { id: string }): ReactElement {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <span className="inline inline-8">
      <span className="mono">{id}</span>
      <Button
        tone="ghost"
        size="sm"
        onClick={() => {
          navigator.clipboard?.writeText(id);
          setCopied(true);
        }}
      >
        {copied ? 'Copied' : 'Copy ID'}
      </Button>
    </span>
  );
}
