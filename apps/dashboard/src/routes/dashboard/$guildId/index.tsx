import type { ModuleSummary } from '@proton/core';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { moduleState } from '../../../components/module/page.tsx';
import { ModuleLink } from '../../../components/module/route.tsx';
import { Workspace } from '../../../components/shell/app-shell.tsx';
import { GuildAvatar } from '../../../components/shell/topbar.tsx';
import { Badge } from '../../../components/ui/controls.tsx';
import { StatusBanner } from '../../../components/ui/feedback.tsx';
import { Icon, type IconName } from '../../../components/ui/icon.tsx';
import {
  MODULE_BY_ID,
  MODULES,
  type ModuleMeta,
  NAV_GROUPS,
} from '../../../lib/modules/catalogue.ts';
import { modulesQuery, sessionQuery } from '../../../lib/queries.ts';
import { SUPPORT_INVITE } from '../../../lib/site-meta.ts';

export const Route = createFileRoute('/dashboard/$guildId/')({
  component: Overview,
});

type Tone = 'blue' | 'cyan' | 'indigo' | 'violet';

function CardBody({
  icon,
  tone,
  title,
  description,
  aside,
}: {
  icon: IconName;
  tone?: Tone | undefined;
  title: string;
  description: string;
  aside?: ReactElement | null | undefined;
}): ReactElement {
  return (
    <>
      <span className={tone ? `overview-tile overview-tile-${tone}` : 'overview-tile'}>
        <Icon name={icon} size={18} weight={tone ? 'fill' : 'regular'} />
      </span>
      <span className="overview-card-title">{title}</span>
      <span className="overview-card-description">{description}</span>
      {aside ? <span className="overview-card-corner">{aside}</span> : null}
    </>
  );
}

function QuickActions({ guildId }: { guildId: string }): ReactElement {
  return (
    <div className="overview-grid overview-grid-actions">
      <Link to="/commands" className="overview-card">
        <CardBody
          icon="book-open"
          tone="blue"
          title="Commands"
          description="Every command and what it does."
        />
      </Link>
      <Link to="/faq" className="overview-card">
        <CardBody
          icon="question"
          tone="cyan"
          title="FAQ"
          description="Answers to common questions."
        />
      </Link>
      <a href={SUPPORT_INVITE} target="_blank" rel="noreferrer" className="overview-card">
        <CardBody
          icon="discord-logo"
          tone="indigo"
          title="Support server"
          description="Ask for help in Proton’s Discord server."
          aside={<Icon name="arrow-square-out" size={14} className="overview-card-aside" />}
        />
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
      <ModuleLink
        guildId={guildId}
        moduleId="branding"
        search={{ area: undefined }}
        className="overview-card"
      >
        <CardBody
          icon="identification-card"
          tone="violet"
          title="Branding"
          description="Change how Proton appears in this server."
        />
      </ModuleLink>
    </div>
  );
}

function ModuleCard({
  guildId,
  meta,
  summary,
}: {
  guildId: string;
  meta: ModuleMeta;
  summary: ModuleSummary | undefined;
}): ReactElement {
  const state = summary ? moduleState(summary) : 'off';

  return (
    <ModuleLink
      guildId={guildId}
      moduleId={meta.id}
      search={{ area: undefined }}
      className="overview-card"
    >
      <CardBody
        icon={meta.icon}
        title={meta.label}
        description={meta.description}
        aside={
          state === 'off' ? (
            <Badge tone="neutral">Off</Badge>
          ) : state === 'attention' ? (
            <Badge tone="warning">Cannot run</Badge>
          ) : null
        }
      />
    </ModuleLink>
  );
}

function Attention({
  modules,
  guildId,
}: {
  modules: readonly ModuleSummary[];
  guildId: string;
}): ReactElement | null {
  const blocked = modules.filter((summary) => moduleState(summary) === 'attention');
  if (blocked.length === 0) return null;

  return (
    <div className="page-banners">
      <StatusBanner
        tone="warning"
        title={
          blocked.length === 1 ? '1 module cannot run' : `${blocked.length} modules cannot run`
        }
      >
        <div className="stack stack-6" style={{ marginTop: 4 }}>
          {blocked.map((summary) => (
            <div key={summary.id}>
              <ModuleLink
                guildId={guildId}
                moduleId={summary.id}
                search={{ area: undefined }}
                className="overview-attention-link"
              >
                {MODULE_BY_ID.get(summary.id)?.label ?? summary.name}
              </ModuleLink>{' '}
              — {summary.status?.disabledReason?.humanReason ?? 'Proton did not say why.'}
            </div>
          ))}
        </div>
      </StatusBanner>
    </div>
  );
}

function Overview(): ReactElement {
  const { guildId } = Route.useParams();
  const { guilds } = useSuspenseQuery(sessionQuery()).data;
  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const guild = guilds.find((candidate) => candidate.id === guildId);
  const byId = new Map(modules.map((summary) => [summary.id, summary]));

  return (
    <Workspace>
      <header className="overview-head">
        {guild ? (
          <span className="overview-guild-icon">
            <GuildAvatar guild={guild} size={56} />
          </span>
        ) : null}
        <div className="overview-head-main">
          <p className="overview-eyebrow">Dashboard</p>
          <h1 className="page-title overview-title">{guild?.name ?? 'Overview'}</h1>
        </div>
      </header>

      <Attention modules={modules} guildId={guildId} />

      <section className="overview-section" aria-labelledby="overview-actions">
        <h2 className="overview-heading" id="overview-actions">
          Quick actions
        </h2>
        <QuickActions guildId={guildId} />
      </section>

      <section className="overview-section" aria-labelledby="overview-modules">
        <h2 className="overview-heading" id="overview-modules">
          Modules
        </h2>
        {NAV_GROUPS.map((group) => {
          const members = MODULES.filter((meta) => meta.group === group.id);
          if (members.length === 0) return null;

          return (
            <div className="overview-group" key={group.id}>
              <h3 className="overview-group-label">{group.label}</h3>
              <div className="overview-grid">
                {members.map((meta) => (
                  <ModuleCard
                    key={meta.id}
                    guildId={guildId}
                    meta={meta}
                    summary={byId.get(meta.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </section>
    </Workspace>
  );
}
