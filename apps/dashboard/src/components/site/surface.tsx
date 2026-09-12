import type { CaseRecord } from '@proton/core';
import type { ReactElement } from 'react';
import { Icon } from '../shell/icon.tsx';
import { actionLook, toneClass } from '../shell/module-meta.ts';
import { UserChip } from '../shell/user-chip.tsx';
import { LOG_CATEGORY_COUNT, LOG_CATEGORY_ROUTING, LOG_EVENT_COUNT } from './catalogue.ts';
import { TICKET_PANEL_CONFIG } from './scene.tsx';

// Three surfaces the dashboard really renders, with fixture values in them: a case as the ledger
// keeps one, the panel settings that compose the ticket message, and the Server logs routing
// table. Typed against the product's own records, so a change to the shape breaks the build here.

const BAN: CaseRecord = {
  id: 'K3M9PQ2',
  caseNumber: 218,
  type: 'ban',
  actorId: '400000000000000002',
  targetId: '400000000000000001',
  moderatorId: '400000000000000002',
  reason: 'Posting scam links in #lounge after a warning',
  moduleId: 'moderation',
  expiresAt: '2026-03-21T20:04:00.000Z',
  revertedAt: '2026-03-16T09:12:00.000Z',
  revertedBy: '400000000000000003',
  dryRun: false,
  createdAt: '2026-03-14T20:04:00.000Z',
};

function stamp(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

function Action({ kind }: { kind: string }): ReactElement {
  const look = actionLook(kind);

  return (
    <span className="fig-action">
      <span className={`tile tile-sm ${toneClass(look.tone)}`}>
        <Icon name={look.icon} weight="fill" />
      </span>
      {look.verb}
    </span>
  );
}

export function CaseFigure(): ReactElement {
  return (
    <figure className="fig fig-case">
      <div className="fig-head">
        <span className="fig-head-title">
          Case <span className="num">#{BAN.caseNumber}</span>
        </span>
        <span className="id">{BAN.id}</span>
        {BAN.revertedAt ? (
          <span className="chip chip-ok fig-head-end">
            reverted <span className="mono">{stamp(BAN.revertedAt)}</span>
          </span>
        ) : null}
      </div>

      <dl className="fig-rows">
        <div className="fig-row">
          <dt>Action</dt>
          <dd>
            <Action kind={BAN.type} />
          </dd>
        </div>
        <div className="fig-row">
          <dt>Target</dt>
          <dd>{BAN.targetId ? <UserChip id={BAN.targetId} as="target" /> : '—'}</dd>
        </div>
        <div className="fig-row">
          <dt>Moderator</dt>
          <dd>{BAN.actorId ? <UserChip id={BAN.actorId} as="moderator" /> : '—'}</dd>
        </div>
        <div className="fig-row">
          <dt>Reason</dt>
          <dd>{BAN.reason}</dd>
        </div>
        <div className="fig-row">
          <dt>When (UTC)</dt>
          <dd>
            <span className="stamp">{stamp(BAN.createdAt)}</span>
          </dd>
        </div>
        {BAN.expiresAt ? (
          <div className="fig-row">
            <dt>Lifts</dt>
            <dd>
              <span className="stamp">{stamp(BAN.expiresAt)}</span>
            </dd>
          </div>
        ) : null}
      </dl>

      {BAN.revertedAt && BAN.revertedBy ? (
        <div className="fig-under">
          <Action kind="unban" />
          <span className="fig-under-meta">
            by <UserChip id={BAN.revertedBy} as="moderator" /> ·{' '}
            <span className="stamp">{stamp(BAN.revertedAt)}</span>
          </span>
          <p className="fig-note">
            The unban is written onto the case it undoes. Case #{BAN.caseNumber} still reads as a
            ban, by the moderator who made it, for the reason they typed.
          </p>
        </div>
      ) : null}

      <figcaption>
        An example case, in the shape the case log keeps them. Targets and moderators are listed by
        ID, not by name.
      </figcaption>
    </figure>
  );
}

export function TicketPanelFigure(): ReactElement {
  return (
    <figure className="fig">
      <div className="fig-head">
        <span className="fig-head-title">Tickets → Panels</span>
        <span className="fig-head-note">Dashboard</span>
      </div>

      <dl className="fig-rows">
        <div className="fig-row">
          <dt>Posted in</dt>
          <dd>
            <span className="mono">#{TICKET_PANEL_CONFIG.channel}</span>
          </dd>
        </div>
        <div className="fig-row">
          <dt>Title</dt>
          <dd>{TICKET_PANEL_CONFIG.title}</dd>
        </div>
        <div className="fig-row">
          <dt>Body</dt>
          <dd>{TICKET_PANEL_CONFIG.body}</dd>
        </div>
        <div className="fig-row">
          <dt>Buttons</dt>
          <dd>
            <span className="fig-tokens">
              {TICKET_PANEL_CONFIG.types.map((type) => (
                <span className="chip" key={type.key}>
                  {type.label}
                </span>
              ))}
            </span>
          </dd>
        </div>
      </dl>

      <figcaption>
        One ticket type per button, each with its own staff roles and intake form.
      </figcaption>
    </figure>
  );
}

const LOG_DEFAULT_CHANNEL = 'server-log';

const LOG_OVERRIDES: Record<string, string> = { moderation: 'mod-log' };

export function LogRoutingFigure(): ReactElement {
  return (
    <figure className="fig">
      <div className="fig-head">
        <span className="fig-head-title">Server logs → Categories and channels</span>
        <span className="fig-head-note">
          {LOG_CATEGORY_COUNT} categories, {LOG_EVENT_COUNT} events
        </span>
      </div>

      <table className="fig-table">
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Logged</th>
            <th scope="col">Channel</th>
          </tr>
        </thead>
        <tbody>
          {LOG_CATEGORY_ROUTING.map((row) => {
            const override = LOG_OVERRIDES[row.key];

            return (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td data-logged={row.on ? 'true' : 'false'}>{row.on ? 'On' : 'Off'}</td>
                <td>
                  {override ? (
                    <span className="mono">#{override}</span>
                  ) : (
                    <span className="fig-muted">Inherit — #{LOG_DEFAULT_CHANNEL}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <figcaption>
        The thirteen categories and the states they arrive in, with example channels. A second table
        behind this one holds all {LOG_EVENT_COUNT} events, so a single one can be switched off or
        sent somewhere of its own.
      </figcaption>
    </figure>
  );
}
