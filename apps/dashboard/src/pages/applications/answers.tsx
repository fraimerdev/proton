import type { ApplicationDetail } from '@proton/module-applications/view';
import type { ReactElement } from 'react';
import { MetaSeparator } from '../../components/ui/collection.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { useLocalDate, When } from '../moderation/reports/when.tsx';
import { answerGroups, isLink, removalNote, THREAD_LABELS } from './labels.ts';
import { Actor } from './timeline.tsx';

export function DateText({ at, now }: { at: number; now: number }): ReactElement {
  const date = useLocalDate(at);

  return date === undefined ? (
    <When at={at} now={now} />
  ) : (
    <time dateTime={new Date(at).toISOString()}>{date}</time>
  );
}

function RemovedAnswers({
  application,
  now,
}: {
  application: ApplicationDetail['application'];
  now: number;
}): ReactElement {
  const why = removalNote(application);

  if (why === 'deleted' && application.deletedAt !== null) {
    return (
      <p className="text-sm text-secondary">
        The answers were deleted on <DateText at={application.deletedAt} now={now} />, when this
        application was deleted.
      </p>
    );
  }

  if (why === 'purged' && application.contentPurgedAt !== null) {
    return (
      <p className="text-sm text-secondary">
        The answers were deleted on <DateText at={application.contentPurgedAt} now={now} />, under
        this server’s keep-for setting.
      </p>
    );
  }

  return <p className="text-sm text-muted">No answers were saved with this application.</p>;
}

export function AnswersSection({
  detail,
  now,
}: {
  detail: ApplicationDetail;
  now: number;
}): ReactElement {
  const { application, answers, sections } = detail;
  const groups = answers === null ? [] : answerGroups(answers, sections);
  const titled = groups.some((group) => group.title !== '');

  return (
    <Section label="Answers" note={`Asked as version ${application.version}`}>
      {answers === null ? (
        <RemovedAnswers application={application} now={now} />
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted">The applicant didn’t answer any questions.</p>
      ) : (
        <div className="stack stack-16">
          {groups.map((group) => (
            <div key={group.id || 'untitled'} className="applications-review-answer-group">
              {titled ? (
                <h3 className="applications-review-group-title">
                  {group.title || 'Other questions'}
                </h3>
              ) : null}
              <Rows className="applications-review-answers">
                {group.answers.map((answer) => (
                  <div key={answer.questionId} className="applications-review-answer">
                    <p className="applications-review-question">{answer.label}</p>
                    {answer.display.trim() === '' ? (
                      <p className="applications-review-reply text-muted">No answer</p>
                    ) : isLink(answer) ? (
                      <p className="applications-review-reply">
                        <a
                          className="applications-review-link"
                          href={answer.display}
                          target="_blank"
                          rel="noopener noreferrer nofollow ugc"
                        >
                          {answer.display}
                          <Icon name="arrow-square-out" size={12} />
                          <span className="visually-hidden"> (opens in a new tab)</span>
                        </a>
                      </p>
                    ) : (
                      <p className="applications-review-reply">{answer.display}</p>
                    )}
                  </div>
                ))}
              </Rows>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

export function ConversationSection({
  thread,
  now,
}: {
  thread: ApplicationDetail['thread'];
  now: number;
}): ReactElement {
  return (
    <Section label="Conversation" note="The applicant sees this">
      {thread.length === 0 ? (
        <p className="text-sm text-muted">Nothing has been sent to the applicant yet.</p>
      ) : (
        <ol className="rows applications-review-thread">
          {thread.map((entry) => (
            <li key={entry.id} className="applications-review-message" data-kind={entry.kind}>
              <p className="applications-review-message-head">
                <span className="applications-review-message-kind">
                  {THREAD_LABELS[entry.kind]}
                </span>
                <MetaSeparator />
                <Actor id={entry.authorId} />
                <MetaSeparator />
                <When at={entry.createdAt} now={now} />
              </p>
              {entry.body === null ? (
                <p className="applications-review-message-body text-muted">
                  This message was removed with the answers.
                </p>
              ) : (
                <p className="applications-review-message-body">{entry.body}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
