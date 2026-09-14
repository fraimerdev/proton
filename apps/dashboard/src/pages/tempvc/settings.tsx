import type { ReactElement } from 'react';
import { NumberStepper, Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import type { TempVcForm } from './shape.ts';

export function GlobalSettings({ form }: { form: TempVcForm }): ReactElement {
  return (
    <>
      <Section label="Owner controls">
        <Rows>
          <SettingRow
            title="Let owners manage their own channel"
            description="If off, owners cannot use /voice or the control panel, whatever each creator channel allows."
            error={form.errorAt('ownerCommands')}
          >
            <Switch
              label="Let owners manage their own channel"
              checked={form.value.ownerCommands}
              onChange={(next) => form.setValue((current) => ({ ...current, ownerCommands: next }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Limits">
        <Rows>
          <SettingRow
            title="New channels per minute"
            description="Discord limits how fast a server can create channels. Past this, Proton waits before creating more."
            error={form.errorAt('serverCreationLimit')}
            note="Counted across all creator channels together."
          >
            <NumberStepper
              label="New channels per minute"
              min={1}
              max={200}
              invalid={form.errorAt('serverCreationLimit') !== undefined}
              value={form.value.serverCreationLimit}
              onChange={(next) =>
                form.setValue((current) => ({
                  ...current,
                  serverCreationLimit: next ?? current.serverCreationLimit,
                }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}
