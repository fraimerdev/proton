import type { AutomodConfig, KeywordPreset } from '@proton/module-automod/config';
import type { ReactElement } from 'react';
import type { ModuleForm } from '../../components/module/form.ts';
import { NumberStepper, Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { TokenField } from './lists.tsx';
import { setField } from './shape.ts';

type Form = ModuleForm<AutomodConfig>;

// KEYWORD_PRESETS itself is not exported from ./config, only the type — so the literals are
// declared here and checked against it rather than duplicated silently.
const PRESETS = ['profanity', 'sexualContent', 'slurs'] as const satisfies readonly KeywordPreset[];

const PRESET_LABEL: Record<KeywordPreset, string> = {
  profanity: 'Profanity',
  sexualContent: 'Sexual content',
  slurs: 'Slurs',
};

const PRESET_DESCRIPTION: Record<KeywordPreset, string> = {
  profanity: 'Block swearing and cursing.',
  sexualContent: 'Block sexually explicit words.',
  slurs: 'Block personal insults and hate speech.',
};

export function NativeArea({ form }: { form: Form }): ReactElement {
  const config = form.value;

  const togglePreset = (preset: KeywordPreset, on: boolean): void => {
    form.setValue((current) =>
      setField(
        current,
        'presets',
        PRESETS.filter((candidate) =>
          candidate === preset ? on : current.presets.includes(candidate),
        ),
      ),
    );
  };

  return (
    <>
      <Section label="Words">
        <Rows>
          <SettingRow
            title="Blocked words"
            description="Discord blocks messages that contain any of these."
            error={form.errorAt('blockedWords')}
            stacked
          >
            <TokenField
              label="Blocked words"
              countLabel="words"
              placeholder="A word or phrase, or paste a list"
              max={1000}
              maxLength={60}
              searchFrom={25}
              value={config.blockedWords}
              onChange={(next) =>
                form.setValue((current) => setField(current, 'blockedWords', next))
              }
            />
          </SettingRow>

          <SettingRow
            title="Allowed words"
            description="Discord never blocks these, even when a blocked word or preset matches."
            error={form.errorAt('allowedWords')}
            stacked
          >
            <TokenField
              label="Allowed words"
              countLabel="words"
              placeholder="A word or phrase, or paste a list"
              max={100}
              maxLength={60}
              searchFrom={25}
              value={config.allowedWords}
              onChange={(next) =>
                form.setValue((current) => setField(current, 'allowedWords', next))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Discord word presets">
        <Rows>
          {PRESETS.map((preset) => (
            <SettingRow
              key={preset}
              title={PRESET_LABEL[preset]}
              description={PRESET_DESCRIPTION[preset]}
            >
              <Switch
                label={PRESET_LABEL[preset]}
                checked={config.presets.includes(preset)}
                onChange={(on) => togglePreset(preset, on)}
              />
            </SettingRow>
          ))}
        </Rows>
      </Section>

      <Section label="Limits">
        <Rows>
          <SettingRow
            title="Discord mention limit"
            description="Set to 0 for no limit."
            error={form.errorAt('mentionLimit')}
          >
            <NumberStepper
              label="Discord mention limit"
              value={config.mentionLimit}
              min={0}
              max={50}
              onChange={(next) =>
                form.setValue((current) =>
                  setField(current, 'mentionLimit', next ?? current.mentionLimit),
                )
              }
            />
          </SettingRow>

          <SettingRow
            title="Discord spam filter"
            description="Let Discord block messages it considers spam."
          >
            <Switch
              label="Discord spam filter"
              checked={config.nativeSpam}
              onChange={(on) => form.setValue((current) => setField(current, 'nativeSpam', on))}
            />
          </SettingRow>
        </Rows>
      </Section>
    </>
  );
}
