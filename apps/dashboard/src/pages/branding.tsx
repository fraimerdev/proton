import {
  BIO_MAX,
  type BrandingConfig,
  brandingConfigSchema,
  NICKNAME_MAX,
} from '@proton/module-branding/config';
import {
  type AssetKind,
  AVATAR_MAX_BYTES,
  BANNER_MAX_BYTES,
  kilobytes,
} from '@proton/module-branding/kinds';
import { type DisplayNameStyle, sameDisplayNameStyle } from '@proton/module-branding/name-style';
import { impersonationReason } from '@proton/module-branding/names';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorPreviewLayout } from '../components/discord/message-editor.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { Switch, TextArea, TextInput } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { ConfirmDialog } from '../components/ui/overlay.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';
import { NAME_STYLE_POLL_MS, nameStyleStatusQuery, protonAccountQuery } from '../lib/queries.ts';
import { queryKeys } from '../lib/query-keys.ts';
import { AssetField, refuseLocally } from './branding/asset-field.tsx';
import {
  accountReadOf,
  BrandingPreview,
  previewNotesFor,
  shownName,
} from './branding/discord-preview.tsx';
import { NameStyleCard } from './branding/name-style/card.tsx';
import { NameStyleDialog } from './branding/name-style/dialog.tsx';
import { savedStyleOf, withStagedStyle } from './branding/name-style/shape.ts';
import {
  discordShowsText,
  nameStyleStatusCopy,
  pollTimeLeft,
  reportsNewOutcome,
} from './branding/name-style/status.tsx';

const STYLE_PATHS = [
  'displayNameStyle.font',
  'displayNameStyle.effect',
  'displayNameStyle.colours',
  'displayNameStyle',
] as const;

interface PollWindow {
  from: number;
  over: boolean;
}

function withHash(
  config: BrandingConfig,
  kind: AssetKind,
  hash: string | undefined,
): BrandingConfig {
  const field = kind === 'avatar' ? 'avatarHash' : 'bannerHash';
  const next = { ...config };

  if (hash === undefined) delete next[field];
  else next[field] = hash;

  return next;
}

function notes(lines: readonly string[]): ReactNode {
  if (lines.length === 0) return undefined;

  return lines.map((line) => (
    <span className="branding-note-line" key={line}>
      {line}
    </span>
  ));
}

function useNameStyleStatus(guildId: string, saved: DisplayNameStyle | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const [poll, setPoll] = useState<PollWindow | null>(null);
  const polling = poll !== null && !poll.over;

  const query = useQuery({
    ...nameStyleStatusQuery(guildId),
    refetchInterval: (current) =>
      polling && current.state.data?.state === 'applying' ? NAME_STYLE_POLL_MS : false,
  });

  const data = query.data;
  const state = data?.state;
  const last = useRef({ saved, enabled });
  const seen = useRef(data);

  useEffect(() => {
    if (sameDisplayNameStyle(last.current.saved, saved) && last.current.enabled === enabled) {
      return;
    }

    last.current = { saved, enabled };
    setPoll({ from: Date.now(), over: false });
    void queryClient.invalidateQueries({ queryKey: queryKeys.nameStyleStatus(guildId) });
  }, [saved, enabled, guildId, queryClient]);

  useEffect(() => {
    if (state === 'applying' && poll === null) setPoll({ from: Date.now(), over: false });
  }, [state, poll]);

  useEffect(() => {
    if (poll === null || poll.over) return;

    const timer = window.setTimeout(
      () => setPoll({ from: poll.from, over: true }),
      pollTimeLeft(poll.from, Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [poll]);

  useEffect(() => {
    const before = seen.current;
    seen.current = data;

    // The live member read is cached for long, and a fast apply is never seen as applying.
    if (reportsNewOutcome(before, data, saved)) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.protonAccount(guildId) });
    }
  }, [data, saved, guildId, queryClient]);

  return {
    status: query.data,
    failed: query.isError,
    pollingOver: poll?.over ?? false,
  };
}

export default function BrandingPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: brandingConfigSchema });
  const toggle = useModuleToggle(guildId, summary);
  const queryClient = useQueryClient();
  const [clearing, setClearing] = useState<AssetKind | null>(null);
  const [styleOpen, setStyleOpen] = useState(false);
  const closeStyle = useCallback(() => setStyleOpen(false), []);
  const read = accountReadOf(useQuery(protonAccountQuery(guildId)));

  const enabled = summary?.enabled ?? form.view.enabled;
  const config = form.value;
  const configKey = queryKeys.moduleConfig(guildId, meta.id);

  const savedStyle = useMemo(() => savedStyleOf(form.view.config), [form.view.config]);
  const styleStatus = useNameStyleStatus(guildId, savedStyle, enabled);
  const statusCopy = nameStyleStatusCopy({
    status: styleStatus.status,
    failed: styleStatus.failed,
    saved: savedStyle,
    draft: config.displayNameStyle,
    pollingOver: styleStatus.pollingOver,
  });
  const discordShows = discordShowsText(
    read.status === 'ready' ? read.account.displayNameStyle : undefined,
  );
  const styleError = STYLE_PATHS.map((path) => form.errorAt(path)).find(
    (message) => message !== undefined,
  );

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
      // The route stored this hash already; a save carrying the old one would orphan the new bytes.
      form.rebase((current) => withHash(current, kind, hash));
      void queryClient.invalidateQueries({ queryKey: configKey });
    },
  });

  const busyWith = asset.isPending ? asset.variables.kind : null;
  const assetFailure = asset.isError
    ? { kind: asset.variables.kind, why: asset.error.message }
    : null;

  const nickname = config.nickname ?? '';
  const impersonation = nickname === '' ? null : impersonationReason(nickname);

  const nicknameNotes: string[] = [];
  if (impersonation !== null) {
    nicknameNotes.push(
      `Proton will not use this nickname because ${impersonation}. Saving still applies everything else.`,
    );
  } else if (nickname !== '') {
    nicknameNotes.push(`${nickname.length} / ${NICKNAME_MAX}`);
  }

  const bio = config.bio ?? '';
  const bioNotes =
    bio === ''
      ? []
      : [
          `${bio.length} / ${BIO_MAX}`,
          `Discord documents no maximum for a server bio. ${BIO_MAX} characters is what its own app allows.`,
        ];

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

      <EditorPreviewLayout
        editor={
          <>
            <Section
              label="Identity"
              intro="Only the nickname and display name style need Change Nickname. The avatar, banner and bio still apply without it."
            >
              <Rows>
                <SettingRow
                  title="Server nickname"
                  description={`Leave empty to use Proton’s own name. Up to ${NICKNAME_MAX} characters.`}
                  error={form.errorAt('nickname')}
                  note={notes(nicknameNotes)}
                >
                  <TextInput
                    width="lg"
                    aria-label="Server nickname"
                    maxLength={NICKNAME_MAX}
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
                  note="Uploading or removing applies straight away."
                >
                  <AssetField
                    kind="avatar"
                    guildId={guildId}
                    hash={config.avatarHash}
                    busy={busyWith === 'avatar'}
                    onFile={(file) => asset.mutate({ kind: 'avatar', file })}
                    onClear={() => setClearing('avatar')}
                  />
                </SettingRow>

                <SettingRow
                  title="Banner"
                  description={`PNG, JPEG or GIF, up to ${kilobytes(BANNER_MAX_BYTES)}.`}
                  error={assetFailure?.kind === 'banner' ? assetFailure.why : undefined}
                  note="Uploading or removing applies straight away."
                  stacked
                >
                  <AssetField
                    kind="banner"
                    guildId={guildId}
                    hash={config.bannerHash}
                    busy={busyWith === 'banner'}
                    onFile={(file) => asset.mutate({ kind: 'banner', file })}
                    onClear={() => setClearing('banner')}
                  />
                </SettingRow>
              </Rows>
            </Section>

            <Section
              label="Display name style"
              intro="A font, effect and colours for Proton’s name in this server."
            >
              <Rows>
                <SettingRow title="Style" stacked error={styleError}>
                  <NameStyleCard
                    style={config.displayNameStyle}
                    name={shownName(config, read)}
                    status={statusCopy}
                    shows={discordShows}
                    onCustomise={() => setStyleOpen(true)}
                    onRemove={() => form.setValue((current) => withStagedStyle(current, null))}
                  />
                </SettingRow>
              </Rows>
            </Section>

            <Section label="Switching off">
              <Rows>
                <SettingRow
                  title="Reset when switched off"
                  description="Remove the server nickname, avatar, banner, bio and display name style."
                  error={form.errorAt('restoreOnDisable')}
                  note="Uploaded images and the display name style are kept and applied again when Branding is switched back on."
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
          </>
        }
        preview={
          <>
            <BrandingPreview guildId={guildId} config={config} read={read} />
            <p className="text-xs text-muted branding-preview-note">
              {notes(previewNotesFor(config, read, enabled))}
            </p>
          </>
        }
      />

      <SaveBar
        dirty={form.dirty}
        saving={form.saving}
        failures={form.failures}
        note="Saving sends Proton’s nickname, bio and display name style to Discord."
        onSave={form.save}
        onReset={form.reset}
      />

      <NameStyleDialog
        open={styleOpen}
        onClose={closeStyle}
        guildId={guildId}
        config={config}
        read={read}
        value={config.displayNameStyle}
        onDone={(next) => {
          form.setValue((current) => withStagedStyle(current, next));
          closeStyle();
        }}
      />

      <ConfirmDialog
        open={clearing === 'avatar'}
        danger
        title="Remove avatar?"
        confirmLabel="Remove"
        onClose={() => setClearing(null)}
        onConfirm={() => {
          setClearing(null);
          asset.mutate({ kind: 'avatar', file: null });
        }}
      >
        The avatar is removed from Proton’s profile in Discord now.
      </ConfirmDialog>

      <ConfirmDialog
        open={clearing === 'banner'}
        danger
        title="Remove banner?"
        confirmLabel="Remove"
        onClose={() => setClearing(null)}
        onConfirm={() => {
          setClearing(null);
          asset.mutate({ kind: 'banner', file: null });
        }}
      >
        The banner is removed from Proton’s profile in Discord now.
      </ConfirmDialog>
    </>
  );
}
