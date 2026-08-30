import type { AppealPanel } from '@proton/module-appeals/config';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { Icon } from '../../components/shell/icon.tsx';
import { documentTitle } from '../../lib/document-title.ts';
import { sessionQuery } from '../../lib/queries.ts';
import { type AppealOutcome, openAppeal, submitAppeal } from '../../server/appeals.ts';

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

  return (
    <div className="plain-page">
      <div className="page verify-page">
        <Link to="/" className="back-link">
          <Icon name="arrow-left" />
          Proton
        </Link>

        {!state.ok && 'signIn' in state ? <SignIn href={state.signIn} /> : null}
        {!state.ok && 'reason' in state ? <Refused reason={state.reason} /> : null}
        {state.ok ? <Resolved state={state} token={token} /> : null}
      </div>
    </div>
  );
}

function SignIn({ href }: { href: string }): ReactElement {
  return (
    <section className="verify-card">
      <h1>Appeal a moderation action</h1>
      <p>
        Sign in with Discord so Proton can confirm this link belongs to you. Proton reads your
        account name and the servers you are in, and nothing else.
      </p>
      <a className="button button-discord" href={href}>
        <Icon name="discord-logo" weight="fill" />
        Continue with Discord
      </a>
    </section>
  );
}

function Refused({ reason }: { reason: string }): ReactElement {
  return (
    <section className="verify-card">
      <h1>That didn&rsquo;t work</h1>
      <p>{reason}</p>
    </section>
  );
}

function Resolved({
  state,
  token,
}: {
  state: Extract<AppealOutcome, { ok: true }>;
  token: string;
}): ReactElement {
  const { view } = state;

  if (view.state === 'open') return <Form panel={view.panel} token={token} />;

  return (
    <section className="verify-card">
      <h1>
        {view.state === 'filed'
          ? 'Your appeal is with the moderators'
          : view.state === 'decided'
            ? `Appeal #${view.appeal.number}`
            : 'This appeal is closed'}
      </h1>
      <p>{view.humanReason}</p>
    </section>
  );
}

function Form({ panel, token }: { panel: AppealPanel; token: string }): ReactElement {
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
    <section className="verify-card appeal-card">
      <h1>{panel.name}</h1>
      {panel.blurb ? <p>{panel.blurb}</p> : null}

      <form
        className="appeal-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {panel.questions.map((question) => (
          <label className="appeal-question" key={question.key}>
            <span>
              {question.label}
              {question.required ? null : <em> (optional)</em>}
            </span>
            <textarea
              maxLength={question.maxLength}
              placeholder={question.placeholder ?? ''}
              required={question.required}
              rows={4}
              value={answers[question.key] ?? ''}
              onChange={(event) =>
                setAnswers((held) => ({ ...held, [question.key]: event.target.value }))
              }
            />
            <small>
              {(answers[question.key] ?? '').length}/{question.maxLength}
            </small>
          </label>
        ))}

        {problem ? (
          <p className="field-error" role="alert">
            {problem}
          </p>
        ) : null}

        <button className="button button-primary" disabled={sending || incomplete} type="submit">
          {sending ? 'Sending…' : 'Send appeal'}
        </button>
      </form>
    </section>
  );
}
