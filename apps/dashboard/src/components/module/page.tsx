import type { ModuleStatusView, ModuleSummary } from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import { Children } from 'react';
import type { ModuleMeta } from '../../lib/modules/catalogue.ts';
import { Button, cx, Switch } from '../ui/controls.tsx';
import { StatusBanner } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';

export type ModuleState = 'on' | 'off' | 'attention';

export function moduleState(summary: ModuleSummary): ModuleState {
  if (!summary.enabled) return 'off';
  if (summary.status && !summary.status.enabled) return 'attention';
  return 'on';
}

interface ModuleHeaderProps {
  meta: ModuleMeta;
  crumb?: ReactNode;
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

export function ModuleBanners({
  moduleName,
  status,
  enabled,
  migrated,
  migrationNote,
  changedElsewhere,
  saveError,
  children,
}: {
  moduleName: string;
  status?: ModuleStatusView | null | undefined;
  enabled: boolean;
  migrated?: boolean | undefined;
  migrationNote?: ReactNode;
  changedElsewhere?: boolean | undefined;
  saveError?: string | null | undefined;
  children?: ReactNode;
}): ReactElement | null {
  const blocked = enabled && status && !status.enabled ? status.disabledReason : undefined;
  const hasChildren = Children.toArray(children).length > 0;

  const anything =
    blocked !== undefined ||
    migrated === true ||
    changedElsewhere === true ||
    (saveError !== null && saveError !== undefined) ||
    hasChildren;

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
              // Verbatim from the registry: it names the missing intent or permission.
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
        <StatusBanner tone="info" title="Settings from an older version">
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
