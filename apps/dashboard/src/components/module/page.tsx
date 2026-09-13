import type { ModuleStatusView, ModuleSummary } from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import type { ModuleMeta } from '../../lib/modules/catalogue.ts';
import { Button, cx, Switch } from '../ui/controls.tsx';
import { StatusBanner } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';
import { ModuleLink } from './route.tsx';

export type ModuleState = 'on' | 'off' | 'attention';

export function moduleState(summary: ModuleSummary): ModuleState {
  if (!summary.enabled) return 'off';
  if (summary.status && !summary.status.enabled) return 'attention';
  return 'on';
}

/* ------------------------------------------------------------------ header */

interface ModuleHeaderProps {
  meta: ModuleMeta;
  /** The drill-down step, shown inline in the title rather than as a breadcrumb bar. */
  crumb?: ReactNode;
  /** Where the crumb goes back to, when one is shown. */
  backTo?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function ModuleHeader({
  meta,
  crumb,
  backTo,
  subtitle,
  actions,
}: ModuleHeaderProps): ReactElement {
  return (
    <header className="page-head">
      <div className="page-head-main">
        <h1 className="page-title">
          <Icon name={meta.icon} size={28} className="page-title-icon" />
          {crumb !== undefined ? (
            <>
              <span className="page-title-crumb">{backTo ?? meta.label}</span>
              <span className="page-title-sep">
                <Icon name="caret-right" size={20} />
              </span>
              <span className="truncate">{crumb}</span>
            </>
          ) : (
            meta.label
          )}
        </h1>
        {subtitle !== undefined ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions !== undefined ? <div className="page-head-actions">{actions}</div> : null}
    </header>
  );
}

/**
 * The module's on/off switch, and the only one in the product: the sidebar shows the same three
 * states as an indicator and never as a control, so the two cannot disagree.
 */
export function ModuleSwitch({
  name,
  enabled,
  onToggle,
  busy = false,
  pending = false,
  state,
}: {
  name: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  busy?: boolean | undefined;
  pending?: boolean | undefined;
  state: ModuleState;
}): ReactElement {
  return (
    <span className={cx('inline inline-8', pending && 'switch-pending')}>
      <span
        className={cx(
          'text-sm',
          state === 'attention' ? 'text-warning' : enabled ? 'text-secondary' : 'text-muted',
        )}
      >
        {state === 'attention' ? 'Cannot run' : enabled ? 'On' : 'Off'}
      </span>
      <Switch
        checked={enabled}
        disabled={busy || pending}
        onChange={onToggle}
        label={`${name} enabled`}
      />
    </span>
  );
}

/* ----------------------------------------------------------------- banners */

/**
 * Everything the page has to say before its settings make sense: that Proton cannot run this
 * module here and why, that stored settings were migrated, that somebody else has saved since this
 * draft was opened, and that the last save was refused.
 */
export function ModuleBanners({
  moduleName,
  status,
  enabled,
  migrated,
  migrationNote,
  changedElsewhere,
  saveError,
  guildId,
  children,
}: {
  moduleName: string;
  status?: ModuleStatusView | null | undefined;
  enabled: boolean;
  migrated?: boolean | undefined;
  migrationNote?: ReactNode;
  changedElsewhere?: boolean | undefined;
  saveError?: string | null | undefined;
  guildId: string;
  children?: ReactNode;
}): ReactElement | null {
  const blocked = enabled && status && !status.enabled ? status.disabledReason : undefined;

  const anything =
    blocked !== undefined ||
    migrated === true ||
    changedElsewhere === true ||
    (saveError !== null && saveError !== undefined) ||
    children !== undefined;

  if (!anything) return null;

  return (
    <div className="page-banners">
      {blocked ? (
        <StatusBanner
          tone="warning"
          title={`Proton cannot run ${moduleName}`}
          actions={
            <Button
              tone="secondary"
              size="sm"
              // Verbatim from the registry, never rewritten: it names the intent or permission
              // that is missing, which is the only thing that tells an admin what to go and fix.
              onClick={() => navigator.clipboard?.writeText(blocked.humanReason)}
            >
              Copy reason
            </Button>
          }
        >
          {blocked.humanReason}
        </StatusBanner>
      ) : null}

      {migrated === true ? (
        <StatusBanner
          tone="info"
          title="Settings from an older version"
          actions={
            <ModuleLink
              guildId={guildId}
              moduleId={status?.id ?? ''}
              search={{ area: undefined }}
              className="button button-secondary button-sm"
            >
              Review
            </ModuleLink>
          }
        >
          {migrationNote ??
            'These settings were saved by an older version of Proton, and some may have changed. Check them, then save to store them in the current format.'}
        </StatusBanner>
      ) : null}

      {changedElsewhere === true ? (
        <StatusBanner tone="warning" title="Someone else saved changes">
          These settings changed while this page was open. Saving now replaces their changes with
          yours. Reset to load theirs instead.
        </StatusBanner>
      ) : null}

      {saveError !== null && saveError !== undefined ? (
        <StatusBanner tone="danger" live="assertive" title="Save failed">
          {saveError}
        </StatusBanner>
      ) : null}

      {children}
    </div>
  );
}

/**
 * A module switched off still shows its settings — an admin configures before switching on — but
 * the page says plainly that nothing here is running yet.
 */
export function DisabledNotice({
  moduleName,
  onEnable,
  busy,
}: {
  moduleName: string;
  onEnable: () => void;
  busy?: boolean | undefined;
}): ReactElement {
  return (
    <StatusBanner
      tone="neutral"
      icon="info"
      title={`${moduleName} is switched off`}
      actions={
        <Button tone="primary" size="sm" busy={busy} onClick={onEnable}>
          Switch on
        </Button>
      }
    >
      Settings are saved, but nothing runs until you switch it on.
    </StatusBanner>
  );
}
