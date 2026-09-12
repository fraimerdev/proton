import type { ModuleSummary } from '@proton/core';
import { type ReactElement, useState } from 'react';
import { PageHead } from './app-shell.tsx';
import { ConfirmDialog } from './confirm.tsx';
import { Icon } from './icon.tsx';
import { type ModuleState, moduleBlurb, moduleState, shortReason } from './module-meta.ts';
import { useToggleModule } from './module-toggle.tsx';

export interface ModuleHeaderProps {
  summary: ModuleSummary;

  // What this module holds in this server, counted from the config the page already has. Absent
  // while the config is still in flight, and on the modules whose areas declare no count.
  fact?: string | null;
}

/**
 * The one line under the module's name. Not the blurb: the overview card the admin arrived from has
 * already shown that, and a module page repeating it spends the top of every screen on prose the
 * reader has just read.
 */
function headFact(state: ModuleState, fact: string | null | undefined): string | null {
  if (fact) return fact;
  if (state === 'off') return 'Off. Nothing happens in this server until this is switched on.';
  if (state === 'running') return 'On, and running in this server.';

  return null;
}

export function ModuleHeader({ summary, fact }: ModuleHeaderProps): ReactElement {
  const toggle = useToggleModule();
  const [confirming, setConfirming] = useState(false);

  const state = moduleState(summary);
  const code = summary.status?.disabledReason?.code;
  const line = headFact(state, fact);

  return (
    <>
      {/* The module names the page and the tab strip names the face. Titling the page after the
          open area moved the h1 and the lede on every tab click, and left the module — the thing
          the switch beside them governs — written nowhere on its own page.

          No category line above the heading either: the sidebar files the module under the
          category on screen, and a grey word over an h1 outranks the heading it labels. */}
      <PageHead
        title={summary.name}
        lede={line === null ? undefined : <span className="module-fact">{line}</span>}
        aside={
          <div className="master-switch-wrap">
            {/* The label wraps the switch so the whole control toggles, and [data-state] has to sit
                on the same element as the input for the blocked and degraded track colours to reach
                it. */}
            <label
              className={`master-switch${summary.enabled ? ' master-switch-on' : ''}`}
              data-state={state}
            >
              <span className="master-switch-line">
                Enabled
                {/* The one thing the generic note cannot say. Without it the coral track is a colour
                    with no word beside it, which the system does not allow. */}
                {state === 'blocked' || state === 'degraded' ? (
                  <span className={`master-switch-state state-${state}`}>{shortReason(code)}</span>
                ) : null}
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={summary.enabled}
                aria-checked={summary.enabled}
                // Carries the visible word and stays put. A name that flipped between "Switch on"
                // and "Switch off" renamed the control on every toggle, and matched no label on
                // screen.
                aria-label={`Enabled — ${summary.name}`}
                aria-describedby={`${summary.id}-switch-note`}
                onChange={(event) => {
                  // Switching something live off is the one write on this page with no Save between
                  // the click and the server, so it is the one that asks first.
                  if (!event.target.checked && state === 'running') setConfirming(true);
                  else toggle(summary, event.target.checked);
                }}
              />
            </label>
            <span className="master-switch-note" id={`${summary.id}-switch-note`}>
              Takes effect immediately
            </span>
          </div>
        }
      />

      {summary.enabled && (state === 'blocked' || state === 'degraded') ? (
        <div className={`gap-card${state === 'degraded' ? ' gap-card-warn' : ''}`}>
          <Icon name={state === 'degraded' ? 'warning' : 'warning-circle'} weight="fill" />
          <div className="gap-body">
            {/* No heading over it. "Not running" read as the card's title beside a switch reading
                "Enabled" and a state word already saying why, and the sentence below it names the
                permission, the intent or the plan — and where to change it — on its own.

                Falls back to the short reason: an empty alert renders a blank block and announces
                nothing, which is the one state a reader cannot recover from. */}
            <p className="gap-text" role="alert">
              {summary.status?.disabledReason?.humanReason ?? shortReason(code)}
            </p>
          </div>
        </div>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title={`Switch ${summary.name} off in this server?`}
          cancelLabel="Keep it on"
          confirmLabel={`Switch ${summary.name} off`}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            toggle(summary, false);
          }}
        >
          {moduleBlurb(summary.id, summary.category)} Proton stops that in this server the moment
          you confirm. The settings are kept, so switching it back on restores them; anything{' '}
          {summary.name} has already put in Discord stays as it is unless its own settings say to
          undo it.
        </ConfirmDialog>
      ) : null}
    </>
  );
}
