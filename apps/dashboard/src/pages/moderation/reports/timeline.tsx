import type { ReportEventView } from '@proton/module-moderation/reports-view';
import type { ReactElement } from 'react';
import { MemberCell } from '../../../components/discord/member.tsx';
import { ModuleLink } from '../../../components/module/route.tsx';
import { MetaSeparator } from '../../../components/ui/collection.tsx';
import { Badge } from '../../../components/ui/controls.tsx';
import { Section } from '../../../components/ui/layout.tsx';
import {
  actorLabel,
  describeEvent,
  isMemberId,
  readableOutcome,
  SOURCE_LABELS,
} from './queue-labels.ts';
import { When } from './when.tsx';

const WARNING_KINDS = new Set([
  'action_failed',
  'delivery_failed',
  'card_missing',
  'close_failed',
  'notification_failed',
]);

const SUCCESS_KINDS = new Set(['accepted', 'action_executed']);

function tone(kind: string): 'warning' | 'success' | undefined {
  if (WARNING_KINDS.has(kind)) return 'warning';
  if (SUCCESS_KINDS.has(kind)) return 'success';
  return undefined;
}

export function Actor({ id }: { id: string | null }): ReactElement {
  if (isMemberId(id)) return <MemberCell userId={id} />;
  return <span className="text-secondary">{actorLabel(id) ?? 'Proton'}</span>;
}

export function CaseLink({ guildId, caseId }: { guildId: string; caseId: string }): ReactElement {
  return (
    <ModuleLink
      className="moderation-link mono text-xs"
      guildId={guildId}
      moduleId="cases"
      search={{ area: 'log', q: caseId, id: caseId }}
    >
      {caseId}
    </ModuleLink>
  );
}

export function ReportTimeline({
  guildId,
  events,
  now,
  mentionNames,
  ruleName,
}: {
  guildId: string;
  events: readonly ReportEventView[];
  now: number;
  mentionNames: ReadonlyMap<string, string>;
  ruleName?: ((id: string) => string | undefined) | undefined;
}): ReactElement {
  return (
    <Section label="Timeline">
      {events.length === 0 ? (
        <p className="text-sm text-muted">Nothing has happened to this report yet.</p>
      ) : (
        <ol className="rows moderation-report-timeline">
          {events.map((event) => {
            const described = describeEvent(event, ruleName);

            return (
              <li key={event.id} className="moderation-report-event" data-tone={tone(event.kind)}>
                <span className="moderation-report-event-dot" aria-hidden />
                <div className="moderation-report-event-main">
                  <p className="moderation-report-event-text">
                    {described.text}
                    {described.member !== undefined ? (
                      <>
                        {' '}
                        <MemberCell userId={described.member} />
                      </>
                    ) : null}
                    {described.caseId !== undefined ? (
                      <>
                        <MetaSeparator />
                        <span className="inline inline-6">
                          Case <CaseLink guildId={guildId} caseId={described.caseId} />
                        </span>
                      </>
                    ) : null}
                  </p>
                  {described.detail !== undefined ? (
                    <p className="moderation-report-event-detail">
                      {readableOutcome(described.detail, mentionNames, now)}
                    </p>
                  ) : null}
                  <p className="moderation-report-event-meta">
                    <Actor id={event.actorId} />
                    <MetaSeparator />
                    <Badge>{SOURCE_LABELS[event.source]}</Badge>
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
