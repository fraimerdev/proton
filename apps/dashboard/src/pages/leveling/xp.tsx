import type { LevelingConfig } from '@proton/module-leveling/config';
import type { ReactElement } from 'react';
import {
  CHANNEL_TYPE,
  ChannelMultiPicker,
  ChannelPicker,
} from '../../components/discord/channel-picker.tsx';
import { DurationInput } from '../../components/discord/inputs.tsx';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { NumberStepper } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';

const XP_PER_MESSAGE_MAX = 1000;
const VOICE_XP_MAX = 100;
const EXCLUSION_MAX = 50;

const EARNING_CHANNEL_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
] as const;

const AFK_CHANNEL_TYPES = [CHANNEL_TYPE.voice, CHANNEL_TYPE.stage] as const;

const NO_MESSAGE_XP = 'Minimum and maximum are both 0, so messages earn no XP.';

const COOLDOWN_NOTE = 'Members earn XP for at most one message in each cooldown.';

const NO_VOICE_XP = 'Set to 0, so time in voice earns no XP and is not tracked.';

const AFK_NOTE =
  'Members do not earn voice XP in this channel, or while deafened, whether by themselves or a ' +
  'moderator.';

const EXCLUSIONS_INTRO =
  'Only ordinary messages and replies earn XP. Bot and webhook messages never do, in any channel.';

const CHANNELS_FULL = `You can add up to ${EXCLUSION_MAX} channels. Remove one to add another.`;

function ExcludedChannels({
  guildId,
  value,
  onChange,
}: {
  guildId: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
}): ReactElement {
  return (
    <ChannelMultiPicker
      guildId={guildId}
      value={value}
      onChange={onChange}
      types={EARNING_CHANNEL_TYPES}
      max={EXCLUSION_MAX}
      label="Add excluded channel"
    />
  );
}

export function EarningArea({
  guildId,
  form,
}: {
  guildId: string;
  form: ModuleForm<LevelingConfig>;
}): ReactElement {
  const config = form.value;

  const minError = form.errorAt('xpPerMessageMin');
  const maxError = form.errorAt('xpPerMessageMax');
  const cooldownError = form.errorAt('messageCooldown');
  const voiceError = form.errorAt('voiceXpPerMinute');

  return (
    <>
      <Section
        label="Messages"
        note={
          config.xpPerMessageMin === 0 && config.xpPerMessageMax === 0 ? NO_MESSAGE_XP : undefined
        }
      >
        <Rows>
          <SettingRow
            title="Minimum XP per message"
            description="Each message earns a random amount of XP between the minimum and maximum."
            error={minError}
          >
            <NumberStepper
              label="Minimum XP per message"
              value={config.xpPerMessageMin}
              min={0}
              max={XP_PER_MESSAGE_MAX}
              invalid={minError !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  xpPerMessageMin: next ?? current.xpPerMessageMin,
                }))
              }
            />
          </SettingRow>

          <SettingRow title="Maximum XP per message" error={maxError}>
            <NumberStepper
              label="Maximum XP per message"
              value={config.xpPerMessageMax}
              min={0}
              max={XP_PER_MESSAGE_MAX}
              invalid={maxError !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  xpPerMessageMax: next ?? current.xpPerMessageMax,
                }))
              }
            />
          </SettingRow>

          <SettingRow title="Message cooldown" error={cooldownError} note={COOLDOWN_NOTE}>
            <DurationInput
              label="Message cooldown"
              value={config.messageCooldown}
              invalid={cooldownError !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, messageCooldown: next }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Voice">
        <Rows>
          <SettingRow
            title="Voice XP"
            description="XP earned for each minute in voice. Proton adds it when the member leaves the channel."
            error={voiceError}
            note={config.voiceXpPerMinute === 0 ? NO_VOICE_XP : undefined}
          >
            <NumberStepper
              label="Voice XP"
              value={config.voiceXpPerMinute}
              min={0}
              max={VOICE_XP_MAX}
              invalid={voiceError !== undefined}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  voiceXpPerMinute: next ?? current.voiceXpPerMinute,
                }))
              }
            />
          </SettingRow>

          <SettingRow title="AFK channel" error={form.errorAt('afkChannelId')} note={AFK_NOTE}>
            <ChannelPicker
              guildId={guildId}
              label="AFK channel"
              placeholder="No AFK channel"
              noneLabel="No AFK channel"
              types={AFK_CHANNEL_TYPES}
              value={config.afkChannelId ?? null}
              onChange={(next) =>
                form.setValue((current) => ({ ...current, afkChannelId: next ?? undefined }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Exclusions" intro={EXCLUSIONS_INTRO}>
        <Rows>
          <SettingRow
            title="Excluded channels"
            description="Messages in these channels earn no XP."
            stacked
            error={form.errorAt('excludedChannelIds')}
            note={config.excludedChannelIds.length >= EXCLUSION_MAX ? CHANNELS_FULL : undefined}
          >
            <ExcludedChannels
              guildId={guildId}
              value={config.excludedChannelIds}
              onChange={(excludedChannelIds) =>
                form.setValue((current) => ({ ...current, excludedChannelIds }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Excluded roles"
            description="Members with any of these roles earn no XP from messages."
            stacked
            error={form.errorAt('excludedRoleIds')}
          >
            <RoleMultiPicker
              guildId={guildId}
              label="Excluded roles"
              max={EXCLUSION_MAX}
              value={config.excludedRoleIds}
              onChange={(excludedRoleIds) =>
                form.setValue((current) => ({ ...current, excludedRoleIds }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}
