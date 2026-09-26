import type { MyApplications, PortalGuild } from '@proton/module-applications/view';
import { referenceOf } from '@proton/module-applications/web';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { Badge } from '../../components/ui/controls.tsx';
import { EmptyState, LoadingArea, StatusBanner } from '../../components/ui/feedback.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import type { ApplyServer } from '../../server/apply.ts';
import {
  ApplyFrame,
  ApplyHead,
  applyServerQuery,
  BackToMine,
  DateText,
  myApplicationsQuery,
  QueryFailure,
  RefusalNotice,
  ServerCrest,
  ServerLine,
  StatusBadge,
} from './shared.tsx';

type ApplicationItem = MyApplications['items'][number];
type ServerForm = PortalGuild['forms'][number];

export interface ServerGroup {
  guildId: string;
  server: ApplyServer | null;
  items: ApplicationItem[];
}

export function groupByServer(
  items: readonly ApplicationItem[],
  servers: readonly ApplyServer[] | null,
): ServerGroup[] {
  const known = new Map((servers ?? []).map((server) => [server.id, server]));
  const groups = new Map<string, ServerGroup>();

  const newest = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const item of newest) {
    const group = groups.get(item.guildId);
    if (group) group.items.push(item);
    else {
      groups.set(item.guildId, {
        guildId: item.guildId,
        server: known.get(item.guildId) ?? null,
        items: [item],
      });
    }
  }

  return [...groups.values()];
}

function ApplicationRow({ item }: { item: ApplicationItem }): ReactElement {
  const draft = item.status === 'draft';

  const content = (
    <>
      <span className="apply-row-main">
        <span className="apply-row-title">
          <span className="truncate">{item.formName}</span>
          {item.number !== null ? (
            <span className="apply-row-ref">{referenceOf(item.number)}</span>
          ) : null}
        </span>
        <span className="apply-row-meta">
          <StatusBadge status={item.status} />
          {draft ? (
            <span>
              Not sent yet · saved <DateText at={item.updatedAt} />
            </span>
          ) : item.submittedAt !== null ? (
            <span>
              Sent <DateText at={item.submittedAt} />
            </span>
          ) : null}
        </span>
      </span>
      <span className="apply-row-go">
        <span className="apply-row-go-text">{draft ? 'Continue' : 'View'}</span>
        <Icon name="caret-right" size={13} />
      </span>
    </>
  );

  if (draft) {
    return (
      <Link
        to="/apply/$guildId/$formId"
        params={{ guildId: item.guildId, formId: item.formId }}
        className="apply-row"
      >
        {content}
      </Link>
    );
  }

  return (
    <Link
      to="/applications/$guildId/$applicationId"
      params={{ guildId: item.guildId, applicationId: item.id }}
      className="apply-row"
    >
      {content}
    </Link>
  );
}

function ApplicationRows({ items }: { items: readonly ApplicationItem[] }): ReactElement {
  return (
    <ul className="apply-rows">
      {items.map((item) => (
        <li key={item.id}>
          <ApplicationRow item={item} />
        </li>
      ))}
    </ul>
  );
}

function serverName(group: ServerGroup, listKnown: boolean): string {
  if (group.server !== null) return group.server.name;
  return listKnown ? 'A server you’ve left' : 'Discord server';
}

export function MyApplicationsPage(): ReactElement {
  const query = useQuery(myApplicationsQuery());

  let body: ReactNode;
  if (query.isPending) {
    body = <LoadingArea label="Loading your applications" minHeight={240} />;
  } else if (query.isError) {
    body = (
      <QueryFailure
        error={query.error}
        what="your applications"
        onRetry={() => void query.refetch()}
      />
    );
  } else if (!query.data.ok) {
    body = <RefusalNotice refusal={query.data} onRetry={() => void query.refetch()} />;
  } else if (query.data.value.items.length === 0) {
    body = (
      <EmptyState icon="identification-card" title="No applications yet">
        When you apply to a server through Proton, your application shows up here. Servers share
        their application links in Discord.
      </EmptyState>
    );
  } else {
    const { items, servers } = query.data.value;

    body = (
      <div className="apply-groups">
        {groupByServer(items, servers).map((group) => {
          const name = serverName(group, servers !== null);

          return (
            <section key={group.guildId} className="apply-group" aria-label={name}>
              <div className="apply-group-head">
                <ServerLine name={name} iconUrl={group.server?.iconUrl ?? null} />
                {servers === null || group.server !== null ? (
                  <Link
                    to="/apply/$guildId"
                    params={{ guildId: group.guildId }}
                    className="apply-link apply-group-link"
                  >
                    Forms in this server
                  </Link>
                ) : null}
              </div>
              <ApplicationRows items={group.items} />
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <ApplyFrame>
      <ApplyHead
        title="Your applications"
        lede="Applications you’ve started or sent to servers that use Proton."
      />
      {body}
    </ApplyFrame>
  );
}

function FormEmoji({ emoji }: { emoji: ServerForm['emoji'] }): ReactNode {
  if (emoji === undefined) return null;
  if (emoji.id !== undefined) {
    return (
      <img
        className="apply-emoji"
        src={`https://cdn.discordapp.com/emojis/${emoji.id}.webp?size=32`}
        alt=""
        width={18}
        height={18}
        loading="lazy"
      />
    );
  }
  return emoji.name !== undefined ? (
    <span className="apply-emoji" aria-hidden>
      {emoji.name}
    </span>
  ) : null;
}

function closedLabel(form: ServerForm): string | null {
  if (form.intake.state === 'open') return null;

  switch (form.intake.reason) {
    case 'not_yet_open':
      return 'Opens later';
    case 'full':
      return 'Full';
    default:
      return 'Closed';
  }
}

function FormRow({ guildId, form }: { guildId: string; form: ServerForm }): ReactElement {
  const closed = closedLabel(form);

  return (
    <Link
      to="/apply/$guildId/$formId"
      params={{ guildId, formId: form.id }}
      className="apply-row apply-form-row"
    >
      <span className="apply-row-main">
        <span className="apply-row-title">
          <FormEmoji emoji={form.emoji} />
          <span className="truncate">{form.name}</span>
          {closed !== null ? <Badge>{closed}</Badge> : null}
        </span>
        {form.description !== '' ? (
          <span className="apply-row-description">{form.description}</span>
        ) : null}
        <span className="apply-row-meta">
          {form.draft !== null ? (
            <span>
              Your answers are saved from <DateText at={form.draft.updatedAt} />.
            </span>
          ) : (
            <span>{form.intakeSentence}</span>
          )}
        </span>
      </span>
      <span className="apply-row-go">
        <span className="apply-row-go-text">
          {form.draft !== null ? 'Continue' : closed === null ? 'Apply' : 'View'}
        </span>
        <Icon name="caret-right" size={13} />
      </span>
    </Link>
  );
}

function ServerForms({ guildId, portal }: { guildId: string; portal: PortalGuild }): ReactElement {
  const forms = [...portal.forms].sort(
    (a, b) => Number(b.intake.state === 'open') - Number(a.intake.state === 'open'),
  );

  return (
    <>
      {!portal.moduleOn ? (
        <StatusBanner tone="info">
          Applications are off in this server right now. You can still check the applications you’ve
          sent.
        </StatusBanner>
      ) : null}

      <section className="apply-block" aria-labelledby="apply-forms-title">
        <h2 className="apply-block-title" id="apply-forms-title">
          Forms
        </h2>
        {forms.length === 0 ? (
          <EmptyState icon="clipboard-text" title="No forms to apply to" inset>
            {portal.moduleOn
              ? 'This server hasn’t opened any application forms yet.'
              : 'Forms show up here once the server turns Applications back on.'}
          </EmptyState>
        ) : (
          <ul className="apply-rows">
            {forms.map((form) => (
              <li key={form.id}>
                <FormRow guildId={guildId} form={form} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {portal.applications.length > 0 ? (
        <section className="apply-block" aria-labelledby="apply-yours-title">
          <h2 className="apply-block-title" id="apply-yours-title">
            Your applications here
          </h2>
          <ApplicationRows
            items={[...portal.applications].sort((a, b) => b.updatedAt - a.updatedAt)}
          />
        </section>
      ) : null}
    </>
  );
}

export function ServerApplyPage({ guildId }: { guildId: string }): ReactElement {
  const query = useQuery(applyServerQuery(guildId));
  const portal = query.data?.ok === true ? query.data.value : null;

  let body: ReactNode;
  if (query.isPending) {
    body = <LoadingArea label="Loading this server’s forms" minHeight={240} />;
  } else if (query.isError) {
    body = (
      <QueryFailure
        error={query.error}
        what="this server’s forms"
        onRetry={() => void query.refetch()}
      />
    );
  } else if (!query.data.ok) {
    body = <RefusalNotice refusal={query.data} onRetry={() => void query.refetch()} />;
  } else {
    body = <ServerForms guildId={guildId} portal={query.data.value} />;
  }

  return (
    <ApplyFrame>
      <ApplyHead
        back={<BackToMine />}
        title={
          portal !== null ? (
            <span className="apply-title-server">
              <ServerCrest name={portal.guild.name} iconUrl={portal.guild.iconUrl} size={36} />
              {portal.guild.name}
            </span>
          ) : (
            'Apply'
          )
        }
        lede={portal !== null ? 'Forms you can apply to in this server.' : undefined}
      />
      {body}
    </ApplyFrame>
  );
}
