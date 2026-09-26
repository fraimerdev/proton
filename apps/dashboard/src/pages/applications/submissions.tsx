import type { QueueItem } from '@proton/module-applications/view';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { z } from 'zod';
import { Workspace } from '../../components/shell/app-shell.tsx';
import { ProtonMark } from '../../components/shell/topbar.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { moduleConfigQuery, rolesQuery, viewerQuery } from '../../lib/queries.ts';
import { ApplicationDetailView } from './detail.tsx';
import type { QueueLocal, SubmissionsSearch } from './labels.ts';
import { applicationMembersQuery } from './queries.ts';
import { ApplicationQueue, type FormOption } from './queue.tsx';

export type { SubmissionsSearch } from './labels.ts';

export type SubmissionsSurface = 'module' | 'review';

const MODULE_ID = 'applications';
const GUILD_ID = /^\d{17,20}$/;

export const reviewSearchSchema = z.object({
  view: z.string().optional(),
  q: z.string().optional(),
  page: z.number().int().min(1).optional(),
  id: z.string().optional(),
});

export type ReviewEntry =
  | { state: 'ready' }
  | { state: 'signed-out'; signIn: string }
  | { state: 'invalid' };

export async function reviewEntry(
  queryClient: QueryClient,
  guildId: string,
  href: string,
): Promise<ReviewEntry> {
  if (!GUILD_ID.test(guildId)) return { state: 'invalid' };

  const viewer = await queryClient.fetchQuery(viewerQuery()).catch(() => null);

  // Not a redirect: someone opening a link from Discord is told what signing in is for first.
  if (viewer?.signedIn !== true) {
    return {
      state: 'signed-out',
      signIn: `/api/auth/signin/discord?redirect=${encodeURIComponent(href)}`,
    };
  }

  return { state: 'ready' };
}

function configuredForms(config: Record<string, unknown> | undefined): FormOption[] {
  const forms = config?.forms;
  if (!Array.isArray(forms)) return [];

  return forms.flatMap((form: unknown) => {
    if (typeof form !== 'object' || form === null) return [];
    const { id, name } = form as { id?: unknown; name?: unknown };
    return typeof id === 'string' && typeof name === 'string' ? [{ id, name }] : [];
  });
}

export function SubmissionsArea({
  guildId,
  surface,
  search,
  onSearch,
}: {
  guildId: string;
  surface: SubmissionsSurface;
  search: SubmissionsSearch;
  onSearch: (patch: Partial<SubmissionsSearch>, options?: { replace?: boolean }) => void;
}): ReactElement {
  const admin = surface === 'module';
  const [local, setLocal] = useState<QueueLocal>({});
  const [seen, setSeen] = useState<ReadonlyMap<string, string>>(() => new Map());

  const config = useQuery({ ...moduleConfigQuery(guildId, MODULE_ID), enabled: admin });
  const roles = useQuery({ ...rolesQuery(guildId), enabled: admin });

  const view = admin ? config.data : undefined;
  const moduleOn = view === undefined ? null : view.enabled && view.config.enabled !== false;

  const forms = useMemo(() => {
    const merged = new Map(configuredForms(view?.config).map((form) => [form.id, form.name]));
    for (const [id, name] of seen) if (!merged.has(id)) merged.set(id, name);

    return [...merged]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [view, seen]);

  const roleNames = useMemo(
    () => new Map((admin ? (roles.data ?? []) : []).map((role) => [role.id, role.name])),
    [admin, roles.data],
  );
  const roleName = useCallback((id: string) => roleNames.get(id), [roleNames]);

  const remember = useCallback((rows: readonly QueueItem[]) => {
    setSeen((current) => {
      const fresh = rows.filter((row) => !current.has(row.formId));
      if (fresh.length === 0) return current;

      const next = new Map(current);
      for (const row of fresh) next.set(row.formId, row.formName);
      return next;
    });
  }, []);

  const source = admin ? undefined : applicationMembersQuery;

  if (search.id !== undefined) {
    return (
      <ApplicationDetailView
        key={search.id}
        guildId={guildId}
        surface={surface}
        applicationId={search.id}
        source={source}
        moduleOn={moduleOn}
        roleName={admin ? roleName : undefined}
        onBack={() => onSearch({ id: undefined })}
      />
    );
  }

  return (
    <ApplicationQueue
      guildId={guildId}
      search={search}
      onSearch={onSearch}
      local={local}
      setLocal={setLocal}
      forms={forms}
      onSeen={remember}
      source={source}
    />
  );
}

export function ReviewFrame({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="shell applications-review-shell">
      <header className="topbar">
        <div className="shell-container topbar-inner">
          <Link to="/" className="topbar-brand">
            <ProtonMark size={24} />
            Proton
          </Link>
        </div>
      </header>

      <div className="shell-container applications-review-body">
        <main className="workspace">
          <Workspace>
            <header className="page-head">
              <div className="page-head-main">
                <h1 className="page-title">
                  <Icon name="identification-card" size={28} className="page-title-icon" />
                  Applications
                </h1>
              </div>
            </header>
            {children}
          </Workspace>
        </main>
      </div>
    </div>
  );
}

function CentredCard({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <main className="centred">
      <section className="centred-card">
        <Link to="/" className="topbar-brand applications-review-card-brand">
          <ProtonMark size={22} />
          Proton
        </Link>
        <h1>{title}</h1>
        <p>{children}</p>
        {action !== undefined ? (
          <div className="applications-review-card-action">{action}</div>
        ) : null}
      </section>
    </main>
  );
}

export function ReviewGate({
  entry,
}: {
  entry: Exclude<ReviewEntry, { state: 'ready' }>;
}): ReactElement {
  if (entry.state === 'invalid') {
    return (
      <CentredCard title="Couldn’t open this page">
        This link doesn’t point to a Discord server. Open it again from the review card in Discord.
      </CentredCard>
    );
  }

  return (
    <CentredCard
      title="Review applications"
      action={
        <a className="button button-primary button-block" href={entry.signIn}>
          <Icon name="discord-logo" size={16} weight="fill" />
          Continue with Discord
        </a>
      }
    >
      Sign in with Discord so Proton can check you’re on this server’s review team. Proton reads
      your Discord user ID, name and avatar and the servers you’re in, and nothing else.
    </CentredCard>
  );
}
