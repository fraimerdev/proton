import type { EntitlementTier, ModuleSummary } from '@proton/core';
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
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  moduleBlurb,
  moduleIcon,
  moduleState,
  shortReason,
} from '../../../components/shell/module-meta.ts';
import { useToggleModule } from '../../../components/shell/module-toggle.tsx';
import { guildQuery, modulesQuery, sessionQuery } from '../../../lib/queries.ts';

export const Route = createFileRoute('/dashboard/$guildId/')({
  loader: ({ context, params }) =>
    context.queryClient.fetchQuery(guildQuery(params.guildId)).then(() => undefined),
  component: GeneralSettings,
  errorComponent: GeneralSettingsError,
});

// Keyed on EntitlementTier, so a tier added to the core list fails typecheck here rather than
// leaking its raw id into the chip the degraded gap card sends people to read.
const TIER_LABELS: Record<EntitlementTier, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
};

function tierLabel(tier: EntitlementTier): string {
  return TIER_LABELS[tier];
}

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

function ModuleRow({ guildId, module }: { guildId: string; module: ModuleSummary }): ReactElement {
  const toggle = useToggleModule();
  const state = moduleState(module);

  return (
    <div className={`module-row${module.enabled ? ' module-row-on' : ''}`} data-state={state}>
      <i>
        <Icon
          name={moduleIcon(module.dashboard?.icon)}
          weight={module.enabled ? 'fill' : 'regular'}
        />
      </i>
      <Link
        to="/dashboard/$guildId/$moduleId"
        params={{ guildId, moduleId: module.id }}
        search={{}}
        className="module-open"
      >
        <span className="module-name">{module.name}</span>
        <span className="module-desc module-desc-prose">
          {moduleBlurb(module.id, module.category)}
        </span>
      </Link>

      {state === 'blocked' || state === 'degraded' ? (
        <span className={`module-warn state-${state}`}>
          {shortReason(module.status?.disabledReason?.code)}
        </span>
      ) : null}

      <input
        type="checkbox"
        role="switch"
        checked={module.enabled}
        aria-checked={module.enabled}
        aria-label={`${module.enabled ? 'Switch off' : 'Switch on'} ${module.name}`}
        onChange={(event) => toggle(module, event.target.checked)}
      />
    </div>
  );
}

function GeneralSettings(): ReactElement {
  const { guildId } = Route.useParams();
  const overview = useSuspenseQuery(guildQuery(guildId)).data;
  const { guilds } = useSuspenseQuery(sessionQuery()).data;
  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const guild = guilds.find((candidate) => candidate.id === guildId);
  const icon = guild ? guildIconUrl(guild) : null;

  return (
    <>
      <PageHead title="Modules" />

      <p className="page-lede">
        Everything Proton can do in {overview.name}. A module does nothing until it is switched on,
        and each one opens on its own settings.
      </p>

      {CATEGORY_ORDER.map((category) => {
        const owned = modules.filter((module) => module.category === category);
        if (owned.length === 0) return null;

        return (
          <section className="module-group" key={category}>
            <h2 className="module-group-title">{CATEGORY_LABELS[category]}</h2>
            <div className="module-list">
              {owned.map((module) => (
                <ModuleRow key={module.id} guildId={guildId} module={module} />
              ))}
            </div>
          </section>
        );
      })}

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
      <PageHead title="Modules" />
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
