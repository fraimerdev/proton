import type { ReactElement } from 'react';
import { RoleMultiPicker, RolePicker } from '../../components/discord/role-picker.tsx';
import { Switch } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import type { HoneypotForm } from './shape.ts';

const EXEMPT_ROLES_MAX = 50;

const NOBODY_EXEMPT =
  'With no exemption set, nobody is exempt — including a member whose roles Proton could not read ' +
  'at the moment they posted.';

export function ExemptionsArea({
  form,
  guildId,
}: {
  form: HoneypotForm;
  guildId: string;
}): ReactElement {
  const config = form.value;

  const nothingExempt =
    !config.exemptAdministrators &&
    config.exemptAdminRoleId === undefined &&
    config.exemptRoleIds.length === 0;

  return (
    <Section label="Roles and permissions">
      <Rows>
        <SettingRow
          title="Exempt administrators"
          description="Anyone holding Administrator is caught and counted, but not acted on."
        >
          <Switch
            label="Exempt administrators"
            checked={config.exemptAdministrators}
            onChange={(next) =>
              form.setValue((current) => ({ ...current, exemptAdministrators: next }))
            }
          />
        </SettingRow>

        <SettingRow title="Exempt admin role" error={form.errorAt('exemptAdminRoleId')}>
          <RolePicker
            guildId={guildId}
            label="Exempt admin role"
            noneLabel="No role"
            requireAssignable={false}
            invalid={form.errorAt('exemptAdminRoleId') !== undefined}
            value={config.exemptAdminRoleId ?? null}
            onChange={(next) =>
              form.setValue((current) => ({ ...current, exemptAdminRoleId: next ?? undefined }))
            }
          />
        </SettingRow>

        <SettingRow
          title="Exempt roles"
          stacked
          error={form.errorAt('exemptRoleIds')}
          badge={
            config.exemptRoleIds.length >= 40 ? (
              <span className="limit-counter">
                {config.exemptRoleIds.length} / {EXEMPT_ROLES_MAX}
              </span>
            ) : undefined
          }
        >
          <RoleMultiPicker
            guildId={guildId}
            label="Exempt roles"
            max={EXEMPT_ROLES_MAX}
            requireAssignable={false}
            value={config.exemptRoleIds}
            onChange={(next) => form.setValue((current) => ({ ...current, exemptRoleIds: next }))}
          />
        </SettingRow>
      </Rows>

      {nothingExempt ? <StatusBanner tone="warning">{NOBODY_EXEMPT}</StatusBanner> : null}
    </Section>
  );
}
