import type { ReactElement } from 'react';
import { Switch } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { armedChannelIds, type HoneypotForm } from './shape.ts';

const NOTHING_ARMED =
  'Camouflage stops while no bait channel is armed. Arm one and save to start it again.';

export function CamouflageArea({ form }: { form: HoneypotForm }): ReactElement {
  const config = form.value;
  const armed = armedChannelIds(config).length;
  const wanted = config.keepChannelActive || config.renameChannelDaily;

  return (
    <Section label="Daily changes">
      <Rows>
        <SettingRow
          title="Keep channels active"
          description="Post a short message in bait channels once a day so they do not look abandoned."
        >
          <Switch
            label="Keep channels active"
            checked={config.keepChannelActive}
            onChange={(next) =>
              form.setValue((current) => ({ ...current, keepChannelActive: next }))
            }
          />
        </SettingRow>

        <SettingRow
          title="Rename channels daily"
          description="Change the ending of each bait channel’s name every day, such as -notes or -archive."
        >
          <Switch
            label="Rename channels daily"
            checked={config.renameChannelDaily}
            onChange={(next) =>
              form.setValue((current) => ({ ...current, renameChannelDaily: next }))
            }
          />
        </SettingRow>
      </Rows>

      {wanted && armed === 0 ? <StatusBanner tone="warning">{NOTHING_ARMED}</StatusBanner> : null}
    </Section>
  );
}
