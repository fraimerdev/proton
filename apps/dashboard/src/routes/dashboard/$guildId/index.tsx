import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import {
  accessLabel,
  guildIconUrl,
  initialsOf,
  PageHead,
} from '../../../components/shell/app-shell.tsx';
import { Icon } from '../../../components/shell/icon.tsx';
import { guildQuery, modulesQuery, sessionQuery } from '../../../lib/queries.ts';

export const Route = createFileRoute('/dashboard/$guildId/')({
  loader: ({ context, params }) =>
    context.queryClient.fetchQuery(guildQuery(params.guildId)).then(() => undefined),
  component: GeneralSettings,
  errorComponent: GeneralSettingsError,
});

const TIER_LABELS: Record<string, string> = {
  free: 'Free',
  premium: 'Premium',
};

function tierLabel(tier: string): string {
  return Object.hasOwn(TIER_LABELS, tier) ? (TIER_LABELS[tier] ?? tier) : tier;
}

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

function GeneralSettings(): ReactElement {
  const { guildId } = Route.useParams();
  const overview = useSuspenseQuery(guildQuery(guildId)).data;
  const { guilds } = useSuspenseQuery(sessionQuery()).data;
  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const guild = guilds.find((candidate) => candidate.id === guildId);
  const icon = guild ? guildIconUrl(guild) : null;
  const on = modules.filter((module) => module.enabled).length;

  return (
    <>
      <PageHead title="General settings" />

      <div className="identity">
        <span className="identity-avatar">
          {icon ? <img src={icon} alt="" width={56} height={56} /> : initialsOf(overview.name)}
        </span>
        <span className="identity-text">
          <span className="identity-name">{overview.name}</span>
          <span className="identity-meta">
            {guild ? accessLabel(guild) : 'Server settings'} · Proton joined{' '}
            {formatDay(overview.joinedAt)}
          </span>
        </span>
      </div>

      <section className="form-section">
        <h2 className="form-section-title">This server</h2>

        <div className="fact-row">
          <span className="fact-row-label">Server ID</span>
          <span className="fact-row-value id">{overview.id}</span>
        </div>

        <div className="fact-row">
          <span className="fact-row-label">
            Plan
            <span className="field-description">
              Sets the ceiling on how many entries each module’s lists may hold.
            </span>
          </span>
          <span className="fact-row-value">
            <span className="chip">{tierLabel(overview.tier)}</span>
          </span>
        </div>

        <div className="fact-row">
          <span className="fact-row-label">
            Modules
            <span className="field-description">
              Switch a module on from its page in the sidebar.
            </span>
          </span>
          <span className="fact-row-value num">
            {on} of {modules.length} on
          </span>
        </div>

        <div className="fact-row">
          <span className="fact-row-label">
            Language
            <span className="field-description">
              Discord reports this server as {overview.locale}. Proton replies in English only, so
              this is not a setting yet.
            </span>
          </span>
          <span className="fact-row-value mono">{overview.locale}</span>
        </div>
      </section>

      <section className="form-section">
        <h2 className="form-section-title">Your data</h2>

        <div className="fact-row">
          <span className="fact-row-label">
            What Proton stores
            <span className="field-description">
              Moderation cases, module settings, and — only where an admin switches it on — message
              edit and deletion logs.
            </span>
          </span>
          <span className="fact-row-value">
            <Link to="/privacy" className="button button-quiet">
              Read the policy
              <Icon name="arrow-right" />
            </Link>
          </span>
        </div>
      </section>

      <p className="status">
        Everything else Proton does is configured per module. Proton has no other server-wide
        settings yet.
      </p>
    </>
  );
}

function GeneralSettingsError({ error }: { error: Error }): ReactElement {
  return (
    <>
      <PageHead title="General settings" />
      <div className="gap-card">
        <div className="gap-body">
          <span className="gap-head">
            <Icon name="warning-circle" weight="fill" className="state-blocked" />
            <span className="gap-name">Proton has no record of this server</span>
          </span>
          <p className="gap-text" role="alert">
            {error.message}
          </p>
          <span className="where">
            <Icon name="arrow-elbow-down-right" />
            Proton writes this record when it joins a server. If it is missing, the bot may have
            been removed and re-added while its gateway was down.
          </span>
        </div>
      </div>
    </>
  );
}
