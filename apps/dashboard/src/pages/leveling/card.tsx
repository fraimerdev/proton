import { cardImageHostAllowed } from '@proton/cards/design';
import { CARD_PRESETS, type CardPreset, paletteFor } from '@proton/cards/presets';
import type { LevelingConfig } from '@proton/module-leveling/config';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import { CardPreview, type CardPreviewOptions } from '../../components/discord/card-preview.tsx';
import { ColourPicker } from '../../components/discord/inputs.tsx';
import { EditorPreviewLayout } from '../../components/discord/message-editor.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { Switch, TextInput, useSlidingIndicator } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { humaniseOption } from '../../lib/enum-labels.ts';

const BACKGROUND_MAX = 2048;

const OFF_HOST =
  'Only images hosted on Discord’s CDN load. This address is not on cdn.discordapp.com or ' +
  'media.discordapp.net, so the card will render without it.';

const RENDER_BUDGET =
  'If the card takes longer than 2 seconds to render, /rank replies with plain numbers instead.';

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
          // biome-ignore lint/a11y/useSemanticElements: the same button group SegmentedControl draws, and a native radio cannot carry the palette swatch beside its label
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={preset === value}
            className="segmented-option"
            onClick={() => onChange(preset)}
          >
            <span className="leveling-swatch">
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

export function RankCardArea({
  guildId,
  form,
}: {
  guildId: string;
  form: ModuleForm<LevelingConfig>;
}): ReactElement {
  const config = form.value;
  const background = config.cardBackgroundUrl;
  const offHost =
    background !== undefined && background !== '' && !cardImageHostAllowed(background);

  const options = useMemo<CardPreviewOptions>(
    () => ({
      kind: 'rank',
      preset: config.cardPreset,
      accent: config.cardAccent,
      background:
        config.cardBackgroundUrl !== undefined && cardImageHostAllowed(config.cardBackgroundUrl)
          ? config.cardBackgroundUrl
          : undefined,
      showRank: config.cardShowRank,
      showPercent: config.cardShowPercent,
      showTotalXp: config.cardShowTotalXp,
    }),
    [
      config.cardPreset,
      config.cardAccent,
      config.cardBackgroundUrl,
      config.cardShowRank,
      config.cardShowPercent,
      config.cardShowTotalXp,
    ],
  );

  const settings = (
    <Section label="Appearance">
      <Rows>
        <SettingRow
          title="Rank card"
          description="Reply to /rank with an image instead of plain numbers."
          error={form.errorAt('rankCard')}
        >
          <Switch
            label="Rank card"
            checked={config.rankCard}
            onChange={(rankCard) => form.setValue((current) => ({ ...current, rankCard }))}
          />
        </SettingRow>

        {config.rankCard ? (
          <>
            <SettingRow title="Card style" stacked error={form.errorAt('cardPreset')}>
              <PresetChoice
                value={config.cardPreset}
                onChange={(cardPreset) => form.setValue((current) => ({ ...current, cardPreset }))}
              />
            </SettingRow>

            <SettingRow
              title="Accent colour"
              description="Colours the progress bar, rank number and avatar ring."
              error={form.errorAt('cardAccent')}
            >
              <ColourPicker
                label="Accent colour"
                value={config.cardAccent}
                onChange={(cardAccent) => form.setValue((current) => ({ ...current, cardAccent }))}
              />
            </SettingRow>

            <SettingRow
              title="Background image"
              description="Only images hosted on Discord’s CDN load."
              stacked
              error={form.errorAt('cardBackgroundUrl')}
              note={offHost ? OFF_HOST : undefined}
            >
              <TextInput
                aria-label="Background image"
                placeholder="https://cdn.discordapp.com/…"
                maxLength={BACKGROUND_MAX}
                invalid={form.errorAt('cardBackgroundUrl') !== undefined}
                value={background ?? ''}
                onChange={(event) =>
                  form.setValue((current) => ({
                    ...current,
                    cardBackgroundUrl: event.currentTarget.value || undefined,
                  }))
                }
              />
            </SettingRow>

            <SettingRow title="Show rank number" error={form.errorAt('cardShowRank')}>
              <Switch
                label="Show rank number"
                checked={config.cardShowRank}
                onChange={(cardShowRank) =>
                  form.setValue((current) => ({ ...current, cardShowRank }))
                }
              />
            </SettingRow>

            <SettingRow title="Show progress percentage" error={form.errorAt('cardShowPercent')}>
              <Switch
                label="Show progress percentage"
                checked={config.cardShowPercent}
                onChange={(cardShowPercent) =>
                  form.setValue((current) => ({ ...current, cardShowPercent }))
                }
              />
            </SettingRow>

            <SettingRow title="Show total XP" error={form.errorAt('cardShowTotalXp')}>
              <Switch
                label="Show total XP"
                checked={config.cardShowTotalXp}
                onChange={(cardShowTotalXp) =>
                  form.setValue((current) => ({ ...current, cardShowTotalXp }))
                }
              />
            </SettingRow>
          </>
        ) : null}
      </Rows>

      {config.rankCard ? <p className="leveling-note">{RENDER_BUDGET}</p> : null}
    </Section>
  );

  if (!config.rankCard) return settings;

  return (
    <EditorPreviewLayout
      editor={settings}
      previewTitle="Rank card"
      preview={<CardPreview guildId={guildId} options={options} alt="Rank card preview" />}
    />
  );
}
