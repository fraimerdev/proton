import type { AutomodConfig } from '@proton/module-automod/config';
import type { ReactElement } from 'react';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { LimitCounter } from '../../components/ui/collection.tsx';
import { Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { ChannelTokens } from './lists.tsx';
import { setField } from './shape.ts';

type Form = ModuleForm<AutomodConfig>;

const ROLE_MAX = 20;
const CHANNEL_MAX = 50;

const ROLE_CEILING =
  'Discord allows up to 20 exempt roles on an AutoMod rule, and Proton copies this list into its rules.';

export function ExemptionsArea({ form, guildId }: { form: Form; guildId: string }): ReactElement {
  const config = form.value;

  return (
    <Section
      label="Skipped messages"
      intro="No check runs on these messages. Exempt roles and channels also apply to the Discord AutoMod rules Proton creates."
    >
      <Rows>
        <SettingRow
          title="Exempt roles"
          description="Skip messages from members with any of these roles."
          badge={
            <LimitCounter used={config.exemptRoleIds.length} ceiling={ROLE_MAX} label="roles" />
          }
          note={config.exemptRoleIds.length >= ROLE_MAX ? ROLE_CEILING : undefined}
          error={form.errorAt('exemptRoleIds')}
          stacked
        >
          <RoleMultiPicker
            guildId={guildId}
            label="Exempt roles"
            max={ROLE_MAX}
            value={config.exemptRoleIds}
            invalid={form.errorAt('exemptRoleIds') !== undefined}
            onChange={(next) =>
              form.setValue((current) => setField(current, 'exemptRoleIds', next))
            }
          />
        </SettingRow>

        <SettingRow
          title="Exempt channels"
          description="Skip messages in these channels and their threads."
          error={form.errorAt('exemptChannelIds')}
          stacked
        >
          <ChannelTokens
            guildId={guildId}
            label="Exempt channels"
            max={CHANNEL_MAX}
            value={config.exemptChannelIds}
            onChange={(next) =>
              form.setValue((current) => setField(current, 'exemptChannelIds', next))
            }
          />
        </SettingRow>

        <SettingRow
          title="Exempt bots"
          note="Proton’s own messages are always skipped, even when this is off."
        >
          <Switch
            label="Exempt bots"
            checked={config.exemptBots}
            onChange={(on) => form.setValue((current) => setField(current, 'exemptBots', on))}
          />
        </SettingRow>
      </Rows>
    </Section>
  );
}
