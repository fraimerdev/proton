import type { ApplicationDetail } from '@proton/module-applications/view';
import type { ReactElement } from 'react';
import { MemberCell, useMember } from '../../components/discord/member.tsx';
import { MetaSeparator } from '../../components/ui/collection.tsx';
import { Badge } from '../../components/ui/controls.tsx';
import { Section } from '../../components/ui/layout.tsx';
import { When } from '../moderation/reports/when.tsx';
import {
  actorLabel,
  historyLabel,
  historyTone,
  isMemberId,
  SOURCE_LABELS,
  statusChange,
} from './labels.ts';

export function Actor({ id }: { id: string }): ReactElement {
  if (isMemberId(id)) return <MemberCell userId={id} />;
  return <span className="text-secondary">{actorLabel(id) ?? 'Proton'}</span>;
}

export function ApplicantCell({ id, name }: { id: string; name: string | null }): ReactElement {
  const member = useMember(id);
  if (member !== undefined || name === null) return <MemberCell userId={id} />;

  return (
    <span className="user-cell">
      <span className="user-avatar avatar-fallback" aria-hidden>
        {[...name].slice(0, 2).join('')}
      </span>
      <span className="user-name">{name}</span>
    </span>
  );
}

export function ApplicationHistory({
  events,
  now,
}: {
  events: ApplicationDetail['history'];
  now: number;
}): ReactElement {
  return (
    <Section label="History">
      {events.length === 0 ? (
        <p className="text-sm text-muted">Nothing has happened to this application yet.</p>
      ) : (
        <ol className="rows applications-review-timeline">
          {events.map((event) => {
            const change = statusChange(event.fromStatus, event.toStatus);

            return (
              <li
                key={event.id}
                className="applications-review-event"
                data-tone={historyTone(event.kind)}
              >
                <span className="applications-review-event-dot" aria-hidden />
                <div className="applications-review-event-main">
                  <p className="applications-review-event-text">{historyLabel(event.kind)}</p>
                  {change !== null ? (
                    <p className="applications-review-event-detail">{change}</p>
                  ) : null}
                  <p className="applications-review-event-meta">
                    <Actor id={event.actorId} />
                    <MetaSeparator />
                    <Badge>{SOURCE_LABELS[event.source] ?? event.source}</Badge>
                    <MetaSeparator />
                    <When at={event.createdAt} now={now} />
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}
