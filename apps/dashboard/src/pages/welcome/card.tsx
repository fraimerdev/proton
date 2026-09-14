import { cardImageHostAllowed } from '@proton/cards/design';
import { CARD_PRESETS, type CardPreset, paletteFor } from '@proton/cards/presets';
import type { WelcomeConfig } from '@proton/module-welcome/config';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { CardPreview, type CardPreviewOptions } from '../../components/discord/card-preview.tsx';
import { ColourPicker } from '../../components/discord/inputs.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import {
  SegmentedControl,
  type SegmentedOption,
  Switch,
  TextInput,
  useSlidingIndicator,
} from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { humaniseOption } from '../../lib/enum-labels.ts';
import type { ConfigErrors } from './errors.ts';

export type CardGreeting = 'welcome' | 'goodbye';

const KINDS: readonly SegmentedOption<CardGreeting>[] = [
  { value: 'welcome', label: 'Welcome' },
  { value: 'goodbye', label: 'Goodbye' },
];

const CARD_BACKGROUND_MAX = 2048;

const OFF_HOST =
  'Only images hosted on Discord’s CDN load. This address is not on cdn.discordapp.com or ' +
  'media.discordapp.net, so the card will render without it.';

function renderableBackground(url: string | undefined): string | undefined {
  return url !== undefined && cardImageHostAllowed(url) ? url : undefined;
}

export function cardOptionsFor(config: WelcomeConfig, kind: CardGreeting): CardPreviewOptions {
  return {
    kind,
    preset: config.preset,
    accent: config.cardAccent,
    background: renderableBackground(config.cardBackgroundUrl),
    showMemberCount: config.cardShowMemberCount,
  };
}

function PresetChoice({
  value,
  onChange,
}: {
  value: CardPreset;
  onChange: (next: CardPreset) => void;
}): ReactElement {
  const { track, indicator } = useSlidingIndicator<HTMLDivElement>(
    CARD_PRESETS.indexOf(value),
    CARD_PRESETS.join(' '),
  );

  return (
    <div ref={track} role="radiogroup" aria-label="Card style" className="segmented">
      <span ref={indicator} className="segmented-thumb" aria-hidden />
      {CARD_PRESETS.map((preset) => {
        const palette = paletteFor(preset);

        return (
          // biome-ignore lint/a11y/useSemanticElements: the same button group the shared SegmentedControl draws, and a native radio cannot carry the palette swatch beside its label
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={preset === value}
            className="segmented-option"
            onClick={() => onChange(preset)}
          >
            <span className="welcome-swatch">
              <span style={{ background: palette.background }} />
              <span style={{ background: palette.surface }} />
              <span style={{ background: palette.accent }} />
            </span>
            {humaniseOption(preset)}
          </button>
        );
      })}
    </div>
  );
}

export function CardArea({
  guildId,
  form,
  errors,
}: {
  guildId: string;
  form: ModuleForm<WelcomeConfig>;
  errors: ConfigErrors;
}): ReactElement {
  const config = form.value;
  const [kind, setKind] = useState<CardGreeting>('welcome');

  const options = useMemo(() => cardOptionsFor(config, kind), [config, kind]);
  const background = config.cardBackgroundUrl;
  const offHost = background !== undefined && !cardImageHostAllowed(background);

  return (
    <div className="welcome-card-area">
      <div className="welcome-card-main stack stack-12">
        {config.card ? (
          <>
            <SegmentedControl
              label="Card to preview"
              value={kind}
              options={KINDS}
              onChange={setKind}
            />
            <CardPreview guildId={guildId} options={options} alt={`The ${kind} card`} />
          </>
        ) : (
          <p className="section-intro">No card is attached. Attach one to preview it here.</p>
        )}
      </div>

      <Section label="Appearance">
        <Rows>
          <SettingRow
            title="Attach a card"
            description="Goes with welcome and goodbye messages, never boosts. Costs an extra image render each time a member joins or leaves."
            error={errors.at('card')}
          >
            <Switch
              label="Attach a card"
              checked={config.card}
              onChange={(next) => form.setValue((current) => ({ ...current, card: next }))}
            />
          </SettingRow>

          {config.card ? (
            <>
              <SettingRow title="Card style" stacked error={errors.at('preset')}>
                <PresetChoice
                  value={config.preset}
                  onChange={(preset) => form.setValue((current) => ({ ...current, preset }))}
                />
              </SettingRow>

              <SettingRow
                title="Accent colour"
                description="Replaces the accent from the card style."
                error={errors.at('cardAccent')}
              >
                <ColourPicker
                  label="Accent colour"
                  value={config.cardAccent}
                  onChange={(cardAccent) =>
                    form.setValue((current) => ({ ...current, cardAccent }))
                  }
                />
              </SettingRow>

              <SettingRow
                title="Background image"
                description="Only images hosted on Discord’s CDN load."
                stacked
                error={errors.at('cardBackgroundUrl')}
                note={offHost ? OFF_HOST : undefined}
              >
                <TextInput
                  aria-label="Background image"
                  placeholder="https://cdn.discordapp.com/…"
                  maxLength={CARD_BACKGROUND_MAX}
                  invalid={errors.at('cardBackgroundUrl') !== undefined}
                  value={background ?? ''}
                  onChange={(event) =>
                    form.setValue((current) => ({
                      ...current,
                      cardBackgroundUrl: event.currentTarget.value || undefined,
                    }))
                  }
                />
              </SettingRow>

              <SettingRow title="Show member count" error={errors.at('cardShowMemberCount')}>
                <Switch
                  label="Show member count"
                  checked={config.cardShowMemberCount}
                  onChange={(next) =>
                    form.setValue((current) => ({ ...current, cardShowMemberCount: next }))
                  }
                />
              </SettingRow>
            </>
          ) : null}
        </Rows>
      </Section>
    </div>
  );
}
