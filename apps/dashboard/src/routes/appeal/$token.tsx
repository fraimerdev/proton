import type { AppealPanel } from '@proton/module-appeals/config';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { ProtonMark } from '../../components/shell/topbar.tsx';
import { Button, TextArea } from '../../components/ui/controls.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { documentTitle } from '../../lib/document-title.ts';
import { sessionQuery } from '../../lib/queries.ts';
import { type AppealOutcome, openAppeal, submitAppeal } from '../../server/appeals.ts';
import { LinkCard } from '../verify/$token.tsx';

type AppealState = AppealOutcome | { ok: false; signIn: string };

export const Route = createFileRoute('/appeal/$token')({
  head: () => ({ meta: [{ title: documentTitle('Appeal') }] }),

  loader: async ({ params, context }): Promise<AppealState> => {
    const session = await context.queryClient.fetchQuery(sessionQuery()).catch(() => null);

    // Not a redirect: bouncing straight to Discord would mean a link opened by a signed-out member
    // leaves the site before they have been told what they are signing in for.
    if (!session?.user) {
      return {
        ok: false,
        signIn: `/api/auth/signin/discord?redirect=${encodeURIComponent(`/appeal/${params.token}`)}`,
      };
    }

    return openAppeal({ data: { token: params.token } });
  },

  component: AppealPage,
});

function AppealPage(): ReactElement {
  const state = Route.useLoaderData();
  const { token } = Route.useParams();

  const open = state.ok && state.view.state === 'open';
  const [startedOnForm] = useState(open);
  const entering = startedOnForm && !open;

  if (!state.ok && 'signIn' in state) {
    return (
      <LinkCard
        entering={entering}
        title="Appeal a moderation action"
        action={
          <a className="button button-primary button-block" href={state.signIn}>
            <Icon name="discord-logo" size={16} weight="fill" />
            Continue with Discord
          </a>
        }
      >
        Sign in with Discord so Proton can confirm this link belongs to you. Proton reads your
        account name and the servers you are in, and nothing else.
      </LinkCard>
    );
  }

  if (!state.ok) {
    return (
      <LinkCard entering={entering} title="Could not open this link" tone="danger">
        {state.reason}
      </LinkCard>
    );
  }

  const { view } = state;

  if (view.state === 'open') return <AppealForm panel={view.panel} token={token} />;

  return (
    <LinkCard
      entering={entering}
      title={
        view.state === 'filed'
          ? 'Appeal sent'
          : view.state === 'decided'
            ? `Appeal #${view.appeal.number}`
            : 'This appeal is closed'
      }
      tone={view.state === 'filed' ? 'success' : 'neutral'}
    >
      {view.humanReason}
    </LinkCard>
  );
}

function AppealForm({ panel, token }: { panel: AppealPanel; token: string }): ReactElement {
  const router = useRouter();

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const incomplete = panel.questions.some(
    (question) => question.required && (answers[question.key] ?? '').trim() === '',
  );

  async function send(): Promise<void> {
    setSending(true);
    setProblem(null);

    const outcome = await submitAppeal({ data: { token, answers } });

    setSending(false);

    // Re-loaded rather than swapped locally: the server decides what this link now shows, and it
    // is the same call that would run if the page were opened fresh.
    if (outcome.ok) await router.invalidate();
    else setProblem(outcome.reason);
  }

  return (
    <main className="centred">
      <section className="centred-card wide">
        <Link to="/" className="topbar-brand" style={{ marginBottom: 18 }}>
          <ProtonMark size={22} />
          Proton
        </Link>

        <h1>{panel.name}</h1>
        {panel.blurb ? <p>{panel.blurb}</p> : null}

        <form
          className="stack stack-16"
          style={{ marginTop: 22 }}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {panel.questions.map((question) => {
            const answer = answers[question.key] ?? '';

            return (
              <div className="field" key={question.key}>
                <label className="field-label" htmlFor={`q-${question.key}`}>
                  {question.label}
                  {question.required ? null : <span className="text-muted"> (optional)</span>}
                </label>
                <TextArea
                  id={`q-${question.key}`}
                  maxLength={question.maxLength}
                  placeholder={question.placeholder ?? ''}
                  required={question.required}
                  rows={4}
                  value={answer}
                  onChange={(event) =>
                    setAnswers((held) => ({ ...held, [question.key]: event.target.value }))
                  }
                />
                <span className="field-hint" style={{ textAlign: 'right' }}>
                  {answer.length} / {question.maxLength}
                </span>
              </div>
            );
          })}

          {problem !== null ? (
            <p className="field-error" role="alert">
              {problem}
            </p>
          ) : null}

          <Button tone="primary" size="lg" type="submit" busy={sending} disabled={incomplete}>
            Send appeal
          </Button>
        </form>
      </section>
    </main>
  );
}
