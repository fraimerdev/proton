import { LOG_CATEGORIES, type LogCategory } from '@proton/module-serverlog/catalogue';
import { LOG_TEXT_CHANNEL_TYPES, type ServerlogConfig } from '@proton/module-serverlog/config';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ChannelPicker, useChannelIndex } from '../../components/discord/channel-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { Button, Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import {
  CATEGORY_CONTENTS,
  CATEGORY_LABEL,
  type ChannelIndex,
  ChannelRef,
  keysOf,
} from './shared.tsx';

const CHAIN =
  'A log goes to its own channel if it has one, otherwise its category’s, otherwise this one. ' +
  'With none of the three set, nothing is posted.';

const AUDIT =
  'Proton needs View Audit Log to receive audit entries at all. Without it most of this catalogue ' +
  'is silent.';

export function Categories({
  guildId,
  form,
}: {
  guildId: string;
  form: ModuleForm<ServerlogConfig>;
}): ReactElement {
  const channels = useChannelIndex(guildId);
  const [setAllOpen, setSetAllOpen] = useState(false);
  const [setAllChannel, setSetAllChannel] = useState<string | null>(null);

  const config = form.value;

  const applyToAll = (): void => {
    form.setValue((current) => {
      const categoryChannels = { ...current.categoryChannels };
      for (const category of LOG_CATEGORIES) categoryChannels[category] = setAllChannel ?? '';
      return { ...current, categoryChannels };
    });

    setSetAllOpen(false);
  };

  return (
    <>
      <Section label="Log channels" intro={CHAIN}>
        <Rows>
          <SettingRow
            title="Default log channel"
            description="Used for events without a category or event channel."
            error={form.errorAt('defaultChannelId')}
          >
            <ChannelPicker
              guildId={guildId}
              label="Default log channel"
              types={LOG_TEXT_CHANNEL_TYPES}
              allowNone
              noneLabel="No default log channel"
              placeholder="No default log channel"
              invalid={form.errorAt('defaultChannelId') !== undefined}
              value={config.defaultChannelId || null}
              onChange={(id) => form.set('defaultChannelId', id ?? '')}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label="Categories"
        note="Messages and Voice are off by default because they are the busiest."
        intro={AUDIT}
        actions={
          <Button
            size="sm"
            onClick={() => {
              setSetAllChannel(null);
              setSetAllOpen(true);
            }}
          >
            Set channel for all
          </Button>
        }
      >
        <div className="matrix">
          {LOG_CATEGORIES.map((category) => (
            <CategoryRow
              key={category}
              guildId={guildId}
              category={category}
              form={form}
              channels={channels}
            />
          ))}
        </div>
      </Section>

      <Dialog
        open={setAllOpen}
        onClose={() => setSetAllOpen(false)}
        title="Set channel for all categories"
        description="Applies to all 13 categories. Events with their own channel keep it."
        footer={
          <>
            <Button onClick={() => setSetAllOpen(false)}>Cancel</Button>
            <Button tone="primary" onClick={applyToAll}>
              Apply
            </Button>
          </>
        }
      >
        <SettingRow
          stacked
          title="Channel"
          description="Replaces the channel set on each category."
        >
          <ChannelPicker
            guildId={guildId}
            label="Channel for all categories"
            types={LOG_TEXT_CHANNEL_TYPES}
            allowNone
            noneLabel="Use default channel"
            placeholder="Use default channel"
            value={setAllChannel}
            onChange={setSetAllChannel}
          />
        </SettingRow>
      </Dialog>
    </>
  );
}

function CategoryRow({
  guildId,
  category,
  form,
  channels,
}: {
  guildId: string;
  category: LogCategory;
  form: ModuleForm<ServerlogConfig>;
  channels: ChannelIndex;
}): ReactElement {
  const config = form.value;
  const keys = keysOf(category);
  const on = config.categories[category];
  const channelId = config.categoryChannels[category];
  const destination = channelId || config.defaultChannelId || '';

  const handPicked = !on && keys.some((key) => config.events[key]?.enabled === true);

  const channelError = form.errorAt(`categoryChannels.${category}`);
  const toggleError = form.errorAt(`categories.${category}`);
  const error = channelError ?? toggleError;

  return (
    <div className="matrix-row serverlog-route-row">
      <div className="matrix-row-main">
        <span className="matrix-row-name" title={CATEGORY_CONTENTS[category]}>
          {CATEGORY_LABEL[category]}
        </span>
        <span className="matrix-row-hint">
          {keys.length} events ·{' '}
          {destination === '' ? 'no channel' : <ChannelRef id={destination} channels={channels} />}
        </span>
      </div>

      <div className="matrix-row-control">
        <ChannelPicker
          guildId={guildId}
          label={`${CATEGORY_LABEL[category]} channel`}
          types={LOG_TEXT_CHANNEL_TYPES}
          allowNone
          noneLabel="Use default channel"
          placeholder="Use default channel"
          width={252}
          invalid={channelError !== undefined}
          value={channelId || null}
          onChange={(id) => form.set(`categoryChannels.${category}`, id ?? '')}
        />
        <Switch
          checked={on}
          label={`${CATEGORY_LABEL[category]} logs`}
          onChange={(next) => form.set(`categories.${category}`, next)}
        />
      </div>

      {error !== undefined ? (
        <p className="serverlog-route-note text-danger" role="alert">
          {error}
        </p>
      ) : handPicked ? (
        <p className="serverlog-route-note">
          Still used by events in this category that are set to On.
        </p>
      ) : null}
    </div>
  );
}
