import type { ModuleSummary } from '@proton/core';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { modulePath } from '../../../components/module/paths.ts';
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
  isServerLevel,
  moduleBlurb,
  moduleIcon,
  moduleState,
  shortReason,
} from '../../../components/shell/module-meta.ts';
import { useToggleModule } from '../../../components/shell/module-toggle.tsx';
import { documentTitle } from '../../../lib/document-title.ts';
import { tierLabel } from '../../../lib/limits.ts';
import { guildQuery, modulesQuery, sessionQuery } from '../../../lib/queries.ts';

export const Route = createFileRoute('/dashboard/$guildId/')({
  loader: ({ context, params }) =>
    context.queryClient
      .fetchQuery(guildQuery(params.guildId))
      .then((overview) => ({ title: documentTitle('Modules', overview.name) })),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.title ?? documentTitle('Modules') }] }),
  component: GeneralSettings,
  errorComponent: GeneralSettingsError,
});

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

// Not a ModuleRow: this is how Proton itself is set up in this server, not a feature to switch on,
// so it carries no toggle and sits outside the categories. The switch that does exist lives on its
// own page, where the sentence beside it can say what it actually governs.
function ServerSettingRow({
  guildId,
  module,
}: {
  guildId: string;
  module: ModuleSummary;
}): ReactElement | null {
  const to = modulePath(module.id);
  if (!to) return null;

  return (
    <Link to={to} params={{ guildId }} search={{}} className="server-setting">
      <i>
        <Icon name={moduleIcon(module.dashboard?.icon)} />
      </i>
      <span className="server-setting-text">
        <span className="server-setting-name">{module.name}</span>
        <span className="server-setting-desc">{moduleBlurb(module.id, module.category)}</span>
      </span>
      <span className="server-setting-state">{module.enabled ? 'On' : 'Off'}</span>
      <Icon name="caret-right" />
    </Link>
  );
}

function ModuleRow({
  guildId,
  module,
}: {
  guildId: string;
  module: ModuleSummary;
}): ReactElement | null {
  const toggle = useToggleModule();
  const state = moduleState(module);

  const to = modulePath(module.id);
  if (!to) return null;

  return (
    <li className={`module-row${module.enabled ? ' module-row-on' : ''}`} data-state={state}>
      <i>
        <Icon
          name={moduleIcon(module.dashboard?.icon)}
          weight={module.enabled ? 'fill' : 'regular'}
        />
      </i>
      <Link to={to} params={{ guildId }} search={{}} className="module-open">
        <span className="module-name">{module.name}</span>
        {/* The row holds one line and ellipsises, so a blurb written past it had no second home. */}
        <span
          className="module-desc module-desc-prose"
          title={moduleBlurb(module.id, module.category)}
        >
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
        // The module names the switch; role="switch" is what says on or off. Naming it "Switch off
        // Automod" renamed the control every time it was used, and said the state twice.
        aria-label={module.name}
        onChange={(event) => toggle(module, event.target.checked)}
      />
    </li>
  );
}

function GeneralSettings(): ReactElement {
  const { guildId } = Route.useParams();
  const overview = useSuspenseQuery(guildQuery(guildId)).data;
  const { guilds } = useSuspenseQuery(sessionQuery()).data;
  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const guild = guilds.find((candidate) => candidate.id === guildId);
  const icon = guild ? guildIconUrl(guild) : null;

  const serverLevel = modules.filter((module) => isServerLevel(module.id));

  return (
    <>
      <PageHead title="Modules" />

      <p className="page-lede">
        Everything Proton can do in {overview.name}. How Proton itself appears here comes first;
        below it, a module does nothing until it is switched on, and each one opens on its own
        settings.
      </p>

      {serverLevel.length > 0 ? (
        <section className="module-group">
          <h2 className="module-group-title">This server</h2>
          <div className="server-settings">
            {serverLevel.map((module) => (
              <ServerSettingRow key={module.id} guildId={guildId} module={module} />
            ))}
          </div>
        </section>
      ) : null}

      {CATEGORY_ORDER.map((category) => {
        const owned = modules.filter(
          (module) => module.category === category && !isServerLevel(module.id),
        );
        if (owned.length === 0) return null;

        return (
          <section className="module-group" key={category}>
            <h2 className="module-group-title">{CATEGORY_LABELS[category]}</h2>
            <ul className="module-list">
              {owned.map((module) => (
                <ModuleRow key={module.id} guildId={guildId} module={module} />
              ))}
            </ul>
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
              Proton replies in English only, so this is not a setting yet.
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
            Proton writes this record when it joins a server, and reads it on every page here. If it
            cannot be read, this server’s modules cannot be configured until it can.
          </span>
        </div>
      </div>
    </>
  );
}
