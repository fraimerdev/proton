import type { ApplicationStatus } from '@proton/core';
import { FORM_ID_MAX, SLUG } from '@proton/module-applications/constants';
import { STATUS_LABELS } from '@proton/module-applications/web';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { Fragment, useSyncExternalStore } from 'react';
import { InlineDiscordMarkdown } from '../../components/discord/markdown.tsx';
import { SitePage } from '../../components/site/chrome.tsx';
import { Badge, Button, cx } from '../../components/ui/controls.tsx';
import { EmptyState, StatusBanner } from '../../components/ui/feedback.tsx';
import { Icon, type IconName } from '../../components/ui/icon.tsx';
import { readFailure } from '../../lib/errors.ts';
import { viewerQuery } from '../../lib/queries.ts';
import { LIVE, STALE } from '../../lib/query-keys.ts';
import {
  type ApplyRefusal,
  type ApplyRefusalKind,
  getApplicationStatus,
  getApplyForm,
  getApplyServer,
  listMyApplications,
} from '../../server/apply.ts';

const GUILD_ID = /^\d{17,20}$/;
const APPLICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isGuildId(value: string): boolean {
  return GUILD_ID.test(value);
}

export function isFormId(value: string): boolean {
  return value.length <= FORM_ID_MAX && SLUG.test(value);
}

export function isApplicationId(value: string): boolean {
  return APPLICATION_ID.test(value);
}

export const applyKeys = {
  all: () => ['apply'] as const,
  mine: () => ['apply', 'mine'] as const,
  server: (guildId: string) => ['apply', 'server', guildId] as const,
  form: (guildId: string, formId: string) => ['apply', 'server', guildId, 'form', formId] as const,
  application: (guildId: string, applicationId: string) =>
    ['apply', 'server', guildId, 'application', applicationId] as const,
};

export function myApplicationsQuery() {
  return queryOptions({
    queryKey: applyKeys.mine(),
    queryFn: () => listMyApplications(),
    staleTime: STALE.browse,
    ...LIVE,
  });
}

export function applyServerQuery(guildId: string) {
  return queryOptions({
    queryKey: applyKeys.server(guildId),
    queryFn: () => getApplyServer({ data: { guildId } }),
    staleTime: STALE.browse,
    ...LIVE,
  });
}

export function applyFormQuery(guildId: string, formId: string) {
  return queryOptions({
    queryKey: applyKeys.form(guildId, formId),
    queryFn: () => getApplyForm({ data: { guildId, formId } }),
    staleTime: STALE.browse,
    ...LIVE,
  });
}

export function applicationStatusQuery(guildId: string, applicationId: string) {
  return queryOptions({
    queryKey: applyKeys.application(guildId, applicationId),
    queryFn: () => getApplicationStatus({ data: { guildId, applicationId } }),
    staleTime: STALE.browse,
    ...LIVE,
  });
}

export type ApplyEntry =
  | { state: 'ready' }
  | { state: 'signed-out'; signIn: string }
  | { state: 'invalid' };

export function signInPath(href: string): string {
  return `/api/auth/signin/discord?redirect=${encodeURIComponent(href)}`;
}

export async function applyEntry(
  queryClient: QueryClient,
  href: string,
  valid: boolean,
  load: () => Promise<unknown>,
): Promise<ApplyEntry> {
  if (!valid) return { state: 'invalid' };

  const viewer = await queryClient.fetchQuery(viewerQuery()).catch(() => null);

  // Not a redirect: someone opening a link from Discord is told what signing in is for first.
  if (viewer?.signedIn !== true) return { state: 'signed-out', signIn: signInPath(href) };

  await load();
  return { state: 'ready' };
}

export function ApplyFrame({ children }: { children: ReactNode }): ReactElement {
  return (
    <SitePage>
      <div className="apply">{children}</div>
    </SitePage>
  );
}

export function ApplyCard({
  title,
  children,
  action,
  tone = 'neutral',
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'danger' | undefined;
}): ReactElement {
  return (
    <SitePage>
      <div className="apply-centred">
        <section className="centred-card apply-card">
          <h1>
            {tone === 'danger' ? (
              <Icon name="warning-circle" size={22} weight="fill" className="text-danger" />
            ) : null}{' '}
            {title}
          </h1>
          <p>{children}</p>
          {action !== undefined ? <div className="apply-card-action">{action}</div> : null}
        </section>
      </div>
    </SitePage>
  );
}

export function ApplyGate({
  entry,
  title,
}: {
  entry: Exclude<ApplyEntry, { state: 'ready' }>;
  title: string;
}): ReactElement {
  if (entry.state === 'invalid') {
    return (
      <ApplyCard title="Couldn’t open this page" tone="danger">
        This link isn’t complete. Open it again from Discord, or go to{' '}
        <Link to="/apply" className="apply-link">
          your applications
        </Link>
        .
      </ApplyCard>
    );
  }

  return (
    <ApplyCard
      title={title}
      action={
        <a className="button button-primary button-block" href={entry.signIn}>
          <Icon name="discord-logo" size={16} weight="fill" />
          Continue with Discord
        </a>
      }
    >
      Sign in with Discord so Proton knows which applications are yours. Proton reads your Discord
      user ID, name and avatar and the servers you’re in, and nothing else.
    </ApplyCard>
  );
}

export function ApplyHead({
  back,
  server,
  title,
  badge,
  lede,
}: {
  back?: ReactNode;
  server?: { name: string; iconUrl: string | null } | null | undefined;
  title: ReactNode;
  badge?: ReactNode;
  lede?: ReactNode;
}): ReactElement {
  return (
    <header className="apply-head">
      {back}
      {server ? <ServerLine name={server.name} iconUrl={server.iconUrl} /> : null}
      <div className="apply-title-line">
        <h1 className="apply-title">{title}</h1>
        {badge}
      </div>
      {lede !== undefined && lede !== null && lede !== '' ? (
        <p className="apply-lede">{lede}</p>
      ) : null}
    </header>
  );
}

export function BackToMine(): ReactElement {
  return (
    <Link to="/apply" className="apply-back">
      <Icon name="caret-left" size={13} />
      Your applications
    </Link>
  );
}

export function BackToServer({ guildId, name }: { guildId: string; name: string }): ReactElement {
  return (
    <Link to="/apply/$guildId" params={{ guildId }} className="apply-back">
      <Icon name="caret-left" size={13} />
      {name}
    </Link>
  );
}

export function ServerCrest({
  name,
  iconUrl,
  size = 24,
}: {
  name: string;
  iconUrl: string | null;
  size?: number;
}): ReactElement {
  if (iconUrl !== null) {
    return (
      <img
        className="apply-crest"
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
      />
    );
  }

  return (
    <span
      className="apply-crest apply-crest-blank"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function ServerLine({
  name,
  iconUrl,
}: {
  name: string;
  iconUrl: string | null;
}): ReactElement {
  return (
    <span className="apply-server">
      <ServerCrest name={name} iconUrl={iconUrl} />
      <span className="truncate">{name}</span>
    </span>
  );
}

const STATUS_TONES: Readonly<
  Record<ApplicationStatus, 'neutral' | 'success' | 'warning' | 'info' | 'primary'>
> = {
  draft: 'neutral',
  submitted: 'info',
  in_review: 'primary',
  needs_info: 'warning',
  waitlisted: 'neutral',
  accepted: 'success',
  rejected: 'neutral',
  withdrawn: 'neutral',
  expired: 'neutral',
};

export function StatusBadge({ status }: { status: ApplicationStatus }): ReactElement {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}

const DAY = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
const DAY_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const UTC_DAY = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
const UTC_DAY_TIME = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const unsubscribed = (): (() => void) => () => undefined;

export function DateText({ at, time = false }: { at: number; time?: boolean }): ReactElement {
  // The server renders in UTC and says so; the reader's own zone is only known once hydrated.
  const text = useSyncExternalStore(
    unsubscribed,
    () => (time ? DAY_TIME : DAY).format(at),
    () => `${(time ? UTC_DAY_TIME : UTC_DAY).format(at)}${time ? ' UTC' : ''}`,
  );

  return <time dateTime={new Date(at).toISOString()}>{text}</time>;
}

export function ProseText({
  text,
  className,
}: {
  text: string;
  className?: string | undefined;
}): ReactElement | null {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');

  if (paragraphs.length === 0) return null;

  return (
    <div className={cx('apply-prose', className)}>
      {paragraphs.map((paragraph, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a paragraph's position in the text is its identity
        <p key={index}>
          {paragraph.split('\n').map((line, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a line's position in the text is its identity
            <Fragment key={at}>
              {at > 0 ? <br /> : null}
              <InlineDiscordMarkdown text={line} />
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}

const REFUSAL_TITLES: Readonly<Record<ApplyRefusalKind, string>> = {
  'not-member': 'You’re not in this server',
  'not-found': 'Couldn’t find this',
  off: 'Applications are off',
  changed: 'This changed',
  unavailable: 'Proton didn’t respond',
  failed: 'Something went wrong',
};

const REFUSAL_ICONS: Readonly<Record<ApplyRefusalKind, IconName>> = {
  'not-member': 'users',
  'not-found': 'warning',
  off: 'prohibit',
  changed: 'warning',
  unavailable: 'warning-circle',
  failed: 'warning-circle',
};

export function RefusalNotice({
  refusal,
  onRetry,
}: {
  refusal: ApplyRefusal;
  onRetry?: (() => void) | undefined;
}): ReactElement {
  const retryable = refusal.kind === 'unavailable' || refusal.kind === 'failed';

  return (
    <EmptyState
      icon={REFUSAL_ICONS[refusal.kind]}
      title={REFUSAL_TITLES[refusal.kind]}
      actions={
        <>
          {retryable && onRetry !== undefined ? (
            <Button tone="primary" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
          <Link to="/apply" className="button button-secondary">
            Your applications
          </Link>
        </>
      }
    >
      {refusal.message}
    </EmptyState>
  );
}

export function QueryFailure({
  error,
  what,
  onRetry,
}: {
  error: unknown;
  what: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <StatusBanner
      tone="danger"
      live="polite"
      actions={
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {readFailure(error, what)}
    </StatusBanner>
  );
}
