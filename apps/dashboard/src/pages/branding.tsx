import type { ModuleConfigView } from '@proton/core';
import { ENHANCED_COLOURS_HINT } from '@proton/module-branding/colour';
import {
  BIO_MAX,
  type BrandingConfig,
  brandingConfigSchema,
  isBlank,
} from '@proton/module-branding/config';
import {
  type AssetKind,
  AVATAR_MAX_BYTES,
  BANNER_MAX_BYTES,
  kilobytes,
} from '@proton/module-branding/kinds';
import { impersonationReason } from '@proton/module-branding/names';
import {
  applyTypeface,
  fitsNickname,
  isTypeface,
  NICKNAME_MAX_UNITS,
  nicknameBudget,
  TYPEFACE_LABELS,
  TYPEFACES,
} from '@proton/module-branding/typeface';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useRef } from 'react';
import { ColourPicker } from '../components/discord/inputs.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import {
  SegmentedControl,
  type SegmentedOption,
  Select,
  Switch,
  TextArea,
  TextInput,
} from '../components/ui/controls.tsx';
import { EmptyState, StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { queryKeys } from '../lib/query-keys.ts';
import { AssetField, refuseLocally } from './branding/asset-field.tsx';
import { BrandingProfile } from './branding/profile.tsx';

type NameEffect = BrandingConfig['nameEffect'];

const EFFECTS: readonly SegmentedOption<NameEffect>[] = [
  { value: 'none', label: 'None' },
  { value: 'solid', label: 'Solid' },
  { value: 'gradient', label: 'Gradient' },
  { value: 'holographic', label: 'Holographic' },
];

const ENHANCED_COLOURS_NOTE =
  ENHANCED_COLOURS_HINT.charAt(0).toUpperCase() + ENHANCED_COLOURS_HINT.slice(1);

function withHash(
  view: ModuleConfigView,
  kind: AssetKind,
  hash: string | undefined,
): ModuleConfigView {
  const field = kind === 'avatar' ? 'avatarHash' : 'bannerHash';
  const config = { ...view.config };

  if (hash === undefined) delete config[field];
  else config[field] = hash;

  return { ...view, config };
}

function notes(lines: readonly string[]): ReactNode {
  if (lines.length === 0) return undefined;

  return lines.map((line) => (
    <span className="branding-note-line" key={line}>
      {line}
    </span>
  ));
}

export default function BrandingPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: brandingConfigSchema });
  const toggle = useModuleToggle(guildId, summary);
  const queryClient = useQueryClient();

  const enabled = summary?.enabled ?? form.view.enabled;
  const config = form.value;
  const configKey = queryKeys.moduleConfig(guildId, meta.id);

  const dirtyNow = useRef(form.dirty);
  dirtyNow.current = form.dirty;

  const asset = useMutation({
    mutationFn: async ({ kind, file }: { kind: AssetKind; file: File | null }) => {
      const url = `/api/guilds/${guildId}/branding/${kind}`;

      if (file === null) {
        const cleared = await fetch(url, { method: 'DELETE' });
        if (!cleared.ok) throw new Error((await cleared.text()).trim());
        return { kind, hash: undefined };
      }

      const refusal = refuseLocally(file, kind);
      if (refusal !== null) throw new Error(refusal);

      const saved = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!saved.ok) throw new Error((await saved.text()).trim());

      const body = (await saved.json()) as { hash?: unknown };
      if (typeof body.hash !== 'string') {
        throw new Error(
          'The image was saved, but Proton did not confirm it. Reload the page to see it.',
        );
      }

      return { kind, hash: body.hash };
    },

    onSuccess: ({ kind, hash }) => {
      // The upload route wrote this hash server-side already, so an open draft has to take it or
      // the next save would send the old one back and orphan the bytes that were just stored.
      if (dirtyNow.current) {
        form.setValue((current) =>
          kind === 'avatar' ? { ...current, avatarHash: hash } : { ...current, bannerHash: hash },
        );
        return;
      }

      queryClient.setQueryData<ModuleConfigView>(configKey, (view) =>
        view === undefined ? undefined : withHash(view, kind, hash),
      );
      void queryClient.invalidateQueries({ queryKey: configKey });
    },
  });

  const busyWith = asset.isPending ? asset.variables.kind : null;
  const assetFailure = asset.isError
    ? { kind: asset.variables.kind, why: asset.error.message }
    : null;

  const nickname = config.nickname ?? '';
  const styled = applyTypeface(nickname, config.typeface);
  const impersonation = nickname === '' ? null : impersonationReason(nickname);

  const nicknameNotes: string[] = [];
  if (nickname !== '' && !fitsNickname(styled)) {
    nicknameNotes.push(
      `This is too long for Discord’s ${NICKNAME_MAX_UNITS}-character limit in the ${TYPEFACE_LABELS[config.typeface]} typeface, which allows ${nicknameBudget(config.typeface)} characters. Shorten it or choose Default.`,
    );
  }
  if (impersonation !== null) {
    nicknameNotes.push(
      `Proton will not use this nickname because ${impersonation}. Saving still applies everything else.`,
    );
  }
  if (nicknameNotes.length === 0 && nickname !== '') {
    nicknameNotes.push(`${styled.length} / ${NICKNAME_MAX_UNITS}`);
  }

  const bio = config.bio ?? '';
  const bioNotes =
    bio === ''
      ? []
      : [
          `${bio.length} / ${BIO_MAX}`,
          `Discord documents no maximum for a server bio. ${BIO_MAX} characters is what its own app allows.`,
        ];

  const effectNotes: string[] = [];
  if (config.nameEffect === 'gradient' || config.nameEffect === 'holographic') {
    effectNotes.push(ENHANCED_COLOURS_NOTE);
  }
  if (config.nameEffect === 'holographic') {
    effectNotes.push(
      'Discord sets all three holographic colours itself, so there are no colours to choose.',
    );
  }

  return (
    <>
      <ModuleHeader
        meta={meta}
        actions={
          <ModuleSwitch
            name={meta.label}
            enabled={enabled}
            state={summary ? moduleState(summary) : 'off'}
            busy={toggle.busy}
            onToggle={toggle.toggle}
          />
        }
      />

      <ModuleBanners
        guildId={guildId}
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        migrated={form.view.migrated}
        migrationNote="Proton used to store the avatar and banner as links to Discord’s CDN. Those links were removed, so upload the images again."
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <div className="editor">
        <div className="editor-main">
          <Section
            label="Identity"
            intro="Only the nickname needs Change Nickname. The avatar, banner and bio still apply without it."
          >
            <Rows>
              <SettingRow
                title="Server nickname"
                description={`Leave empty to use Proton’s own name. Up to ${NICKNAME_MAX_UNITS} characters.`}
                error={form.errorAt('nickname')}
                note={notes(nicknameNotes)}
              >
                <TextInput
                  width="lg"
                  aria-label="Server nickname"
                  maxLength={NICKNAME_MAX_UNITS}
                  placeholder="Proton"
                  invalid={form.errorAt('nickname') !== undefined}
                  value={nickname}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    // Empty stores undefined, never '': config is the whole desired face, and a
                    // cleared field has to read as null so the clear is pushed to Discord.
                    form.setValue((current) => ({
                      ...current,
                      nickname: next === '' ? undefined : next,
                    }));
                  }}
                />
              </SettingRow>

              <SettingRow
                title="Server bio"
                description={`Shown as “About me” on Proton’s profile. Up to ${BIO_MAX} characters.`}
                stacked
                error={form.errorAt('bio')}
                note={notes(bioNotes)}
              >
                <TextArea
                  rows={3}
                  aria-label="Server bio"
                  maxLength={BIO_MAX}
                  invalid={form.errorAt('bio') !== undefined}
                  value={bio}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    form.setValue((current) => ({
                      ...current,
                      bio: next === '' ? undefined : next,
                    }));
                  }}
                />
              </SettingRow>

              <SettingRow
                title="Avatar"
                description={`PNG, JPEG or GIF, up to ${kilobytes(AVATAR_MAX_BYTES)}.`}
                error={assetFailure?.kind === 'avatar' ? assetFailure.why : undefined}
              >
                <AssetField
                  kind="avatar"
                  guildId={guildId}
                  hash={config.avatarHash}
                  busy={busyWith === 'avatar'}
                  onFile={(file) => asset.mutate({ kind: 'avatar', file })}
                  onClear={() => asset.mutate({ kind: 'avatar', file: null })}
                />
              </SettingRow>

              <SettingRow
                title="Banner"
                description={`PNG, JPEG or GIF, up to ${kilobytes(BANNER_MAX_BYTES)}.`}
                error={assetFailure?.kind === 'banner' ? assetFailure.why : undefined}
                stacked
              >
                <AssetField
                  kind="banner"
                  guildId={guildId}
                  hash={config.bannerHash}
                  busy={busyWith === 'banner'}
                  onFile={(file) => asset.mutate({ kind: 'banner', file })}
                  onClear={() => asset.mutate({ kind: 'banner', file: null })}
                />
              </SettingRow>
            </Rows>
          </Section>

          <Section label="Name style">
            <Rows>
              <SettingRow
                title="Typeface"
                description="Discord has no font setting for bots, so Proton spells its name in look-alike Unicode letters. Mentions still work, but searching the member list for the plain name will not find it, and screen readers read it letter by letter."
                error={form.errorAt('typeface')}
                note={
                  config.typeface !== 'none' && config.typeface !== 'wide'
                    ? `This typeface uses two characters per letter, so the nickname can be up to ${nicknameBudget(config.typeface)} characters.`
                    : undefined
                }
              >
                <Select
                  width="md"
                  aria-label="Typeface"
                  value={config.typeface}
                  options={TYPEFACES.map((face) => ({
                    value: face,
                    // Each option wears its own face, because "script" names nothing an admin can picture.
                    label: applyTypeface(TYPEFACE_LABELS[face], face),
                  }))}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    if (!isTypeface(next)) return;
                    form.setValue((current) => ({ ...current, typeface: next }));
                  }}
                />
              </SettingRow>

              <SettingRow
                title="Effect"
                description={
                  'Colour Proton’s name with a role it creates for itself. Gradient and holographic need Discord’s Enhanced Role Colours feature.'
                }
                error={form.errorAt('nameEffect')}
                note={notes(effectNotes)}
              >
                <SegmentedControl
                  label="Effect"
                  options={EFFECTS}
                  value={config.nameEffect}
                  onChange={(next) =>
                    form.setValue((current) => ({ ...current, nameEffect: next }))
                  }
                />
              </SettingRow>

              {config.nameEffect === 'solid' || config.nameEffect === 'gradient' ? (
                <SettingRow
                  title="First colour"
                  description="The colour of Proton’s name, or where a gradient starts."
                  error={form.errorAt('primaryColor')}
                >
                  <ColourPicker
                    label="First colour"
                    value={config.primaryColor}
                    onChange={(next) =>
                      form.setValue((current) => ({ ...current, primaryColor: next }))
                    }
                  />
                </SettingRow>
              ) : null}

              {config.nameEffect === 'gradient' ? (
                <SettingRow
                  title="Second colour"
                  description="Where the gradient ends."
                  error={form.errorAt('secondaryColor')}
                  note="Discord role gradients use exactly two colours."
                >
                  <ColourPicker
                    label="Second colour"
                    value={config.secondaryColor}
                    onChange={(next) =>
                      form.setValue((current) => ({ ...current, secondaryColor: next }))
                    }
                  />
                </SettingRow>
              ) : null}
            </Rows>
          </Section>

          <Section label="Switching off">
            <Rows>
              <SettingRow
                title="Reset when switched off"
                description="Remove the server nickname, avatar, banner and bio."
                error={form.errorAt('restoreOnDisable')}
                note="Uploaded images are kept and applied again when Branding is switched back on."
              >
                <Switch
                  label="Reset when switched off"
                  checked={config.restoreOnDisable}
                  onChange={(next) =>
                    form.setValue((current) => ({ ...current, restoreOnDisable: next }))
                  }
                />
              </SettingRow>
            </Rows>
          </Section>
        </div>

        <div className="editor-preview">
          <div className="editor-preview-head">
            <span className="editor-preview-title">Preview</span>
          </div>

          {isBlank(config) ? (
            <EmptyState icon="identification-card" title="No branding" inset>
              Add a nickname, avatar, banner, bio or effect.
            </EmptyState>
          ) : (
            <>
              <BrandingProfile guildId={guildId} config={config} />
              {config.bannerHash !== undefined ? (
                <p className="text-xs text-muted branding-preview-note">
                  Discord crops banners to its own shape, so this is approximate.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        note="Saving also updates Proton’s nickname, avatar, banner, bio and name colour in Discord."
        onSave={form.save}
        onReset={() => {
          form.reset();
          // Reset drops the hashes the draft was carrying from an upload, so the server's copy —
          // which already holds them — has to be read again.
          void queryClient.invalidateQueries({ queryKey: configKey });
        }}
      />
    </>
  );
}
