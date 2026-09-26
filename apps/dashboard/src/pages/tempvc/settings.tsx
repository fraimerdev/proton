import type { ReactElement } from 'react';
import { Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import type { TempVcForm } from './shape.ts';

export function GlobalSettings({ form }: { form: TempVcForm }): ReactElement {
  return (
    <Section label="Owner controls">
      <Rows>
        <SettingRow
          title="Let owners manage their own channel"
          description="If off, owners can’t use /voice or the control panel, whatever each creator channel allows."
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
  );
}
