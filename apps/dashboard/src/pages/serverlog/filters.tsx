import { IGNORABLE_CHANNEL_TYPES, type ServerlogConfig } from '@proton/module-serverlog/config';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ChannelMultiPicker } from '../../components/discord/channel-picker.tsx';
import { MemberCell, MemberProvider } from '../../components/discord/member.tsx';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { LimitCounter } from '../../components/ui/collection.tsx';
import { Button, Chip, Switch, TextInput } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';

const CHANNEL_MAX = 100;
const ROLE_MAX = 50;
const USER_MAX = 100;

const USER_ID = /^\d{17,20}$/;

const SELF = 'Activity in log channels is never logged, so Proton cannot log its own posts.';

export function Filters({
  guildId,
  form,
}: {
  guildId: string;
  form: ModuleForm<ServerlogConfig>;
}): ReactElement {
  const config = form.value;

  return (
    <Section label="Exemptions" intro={SELF}>
      <Rows>
        <SettingRow
          title="Ignored channels"
          description="Activity in these channels is not logged."
          error={firstError(form, 'ignoredChannelIds')}
          badge={
            <LimitCounter
              used={config.ignoredChannelIds.length}
              ceiling={CHANNEL_MAX}
              label="ignored channels"
            />
          }
        >
          <ChannelChips
            guildId={guildId}
            value={config.ignoredChannelIds}
            max={CHANNEL_MAX}
            onChange={(next) => form.set('ignoredChannelIds', next)}
          />
        </SettingRow>

        <SettingRow
          title="Ignored roles"
          description="Actions by members with these roles are not logged."
          error={firstError(form, 'ignoredRoleIds')}
          badge={
            <LimitCounter
              used={config.ignoredRoleIds.length}
              ceiling={ROLE_MAX}
              label="ignored roles"
            />
          }
        >
          <RoleMultiPicker
            guildId={guildId}
            label="Ignored roles"
            includeEveryone
            max={ROLE_MAX}
            value={config.ignoredRoleIds}
            onChange={(next) => form.set('ignoredRoleIds', next)}
          />
        </SettingRow>

        <SettingRow
          title="Ignored user IDs"
          description="Actions by these users are not logged. Turn on Developer Mode in Discord to see Copy User ID."
          error={firstError(form, 'ignoredUserIds')}
          badge={
            <LimitCounter
              used={config.ignoredUserIds.length}
              ceiling={USER_MAX}
              label="ignored user IDs"
            />
          }
        >
          <UserIds
            guildId={guildId}
            value={config.ignoredUserIds}
            max={USER_MAX}
            onChange={(next) => form.set('ignoredUserIds', next)}
          />
        </SettingRow>

        <SettingRow title="Ignore bots" error={form.errorAt('ignoreBots')}>
          <Switch
            checked={config.ignoreBots}
            label="Ignore bots"
            onChange={(next) => form.set('ignoreBots', next)}
          />
        </SettingRow>
      </Rows>
    </Section>
  );
}

function firstError(form: ModuleForm<ServerlogConfig>, path: string): string | undefined {
  const whole = form.errorAt(path);
  if (whole !== undefined) return whole;

  for (const [key, message] of form.errors) {
    if (key.startsWith(`${path}.`)) return message;
  }

  return undefined;
}

function ChannelChips({
  guildId,
  value,
  max,
  onChange,
}: {
  guildId: string;
  value: readonly string[];
  max: number;
  onChange: (next: string[]) => void;
}): ReactElement {
  return (
    <div className="serverlog-chip-field">
      <ChannelMultiPicker
        guildId={guildId}
        value={value}
        onChange={onChange}
        types={IGNORABLE_CHANNEL_TYPES}
        max={max}
        label="Add ignored channel"
      />
    </div>
  );
}

function UserIds({
  guildId,
  value,
  max,
  onChange,
}: {
  guildId: string;
  value: readonly string[];
  max: number;
  onChange: (next: string[]) => void;
}): ReactElement {
  const [draft, setDraft] = useState('');
  const [refused, setRefused] = useState(false);

  const trimmed = draft.trim();
  const valid = USER_ID.test(trimmed);
  const atMax = value.length >= max;

  const add = (): void => {
    if (!valid) {
      setRefused(true);
      return;
    }

    setRefused(false);
    setDraft('');
    if (atMax || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
  };

  return (
    <div className="stack stack-6 serverlog-chip-field">
      <MemberProvider guildId={guildId} userIds={value}>
        {value.length > 0 ? (
          <div className="chip-list">
            {value.map((id) => (
              <Chip
                key={id}
                removeLabel={`Remove ${id}`}
                onRemove={() => onChange(value.filter((current) => current !== id))}
              >
                <MemberCell userId={id} />
              </Chip>
            ))}
          </div>
        ) : null}
      </MemberProvider>

      <div className="inline inline-6">
        <TextInput
          value={draft}
          width="sm"
          inputMode="numeric"
          placeholder="User ID"
          aria-label="User ID to ignore"
          disabled={atMax}
          invalid={refused && !valid}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setRefused(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add();
          }}
        />
        <Button tone="secondary" size="sm" disabled={atMax || trimmed === ''} onClick={add}>
          Add
        </Button>
      </div>

      {refused && !valid ? (
        <span className="field-error" role="alert">
          Enter a Discord user ID: a number of 17 to 20 digits.
        </span>
      ) : atMax ? (
        <span className="row-note">
          You can add up to {max} user IDs. Remove one to add another.
        </span>
      ) : null}
    </div>
  );
}
