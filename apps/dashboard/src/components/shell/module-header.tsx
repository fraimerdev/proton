import type { ModuleSummary } from '@proton/core';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import type { AreaEntry } from '../panels/areas.ts';
import { PageHead } from './app-shell.tsx';
import { Icon } from './icon.tsx';
import {
  CATEGORY_LABELS,
  isCategory,
  moduleBlurb,
  moduleState,
  SWITCH_NOTE,
  shortReason,
  whereToFix,
} from './module-meta.ts';
import { useToggleModule } from './module-toggle.tsx';

export interface ModuleHeaderProps {
  guildId: string;
  summary: ModuleSummary;
  area: AreaEntry | undefined;

  // Off on a data view, which carries its own lede about what the rows are and are not.
  showLede: boolean;
}

export function ModuleHeader({
  guildId,
  summary,
  area,
  showLede,
}: ModuleHeaderProps): ReactElement {
  const toggle = useToggleModule();

  const state = moduleState(summary);
  const code = summary.status?.disabledReason?.code;
  const where = whereToFix(code);

  return (
    <>
      <PageHead
        title={area ? area.title : summary.name}
        trail={
          area ? (
            <Link
              to="/dashboard/$guildId/$moduleId"
              params={{ guildId, moduleId: summary.id }}
              search={{}}
            >
              {summary.name}
            </Link>
          ) : isCategory(summary.category) ? (
            CATEGORY_LABELS[summary.category]
          ) : null
        }
      />

      {showLede ? (
        <p className="page-lede">{area ? area.blurb : moduleBlurb(summary.id, summary.category)}</p>
      ) : null}

      {/* The label wraps the switch so the whole bar toggles, and [data-state] has to sit on the
          same element as the input for the blocked and degraded track colours to reach it. */}
      <label
        className={`master-switch${summary.enabled ? ' master-switch-on' : ''}`}
        data-state={state}
      >
        <span className="master-switch-text">
          <span className="master-switch-line">
            Enabled
            {/* The one thing the generic note cannot say. Without it the coral track is a colour
                with no word beside it, which the system does not allow. */}
            {state === 'blocked' || state === 'degraded' ? (
              <span className={`master-switch-state state-${state}`}>{shortReason(code)}</span>
            ) : null}
          </span>
          <span className="master-switch-note">{SWITCH_NOTE}</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={summary.enabled}
          aria-checked={summary.enabled}
          aria-label={`${summary.enabled ? 'Switch off' : 'Switch on'} ${summary.name}`}
          onChange={(event) => toggle(summary, event.target.checked)}
        />
      </label>

      {summary.enabled && (state === 'blocked' || state === 'degraded') ? (
        <div className={`gap-card${state === 'degraded' ? ' gap-card-warn' : ''}`}>
          <div className="gap-body">
            <span className="gap-head">
              <Icon
                name={state === 'degraded' ? 'warning' : 'warning-circle'}
                weight="fill"
                className={`state-${state}`}
              />
              <span className="gap-name">Not running</span>
            </span>
            <p className="gap-text" role="alert">
              {summary.status?.disabledReason?.humanReason}
            </p>
            {where ? (
              <span className="where">
                <Icon name="arrow-elbow-down-right" />
                {where}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
