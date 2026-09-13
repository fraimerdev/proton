import type { V2Component } from '@proton/core';
import { helpConfigSchema } from '@proton/module-help/config';
import type { ReactElement } from 'react';
import { DiscordPreview } from '../components/discord/message-preview.tsx';
import { useModuleForm } from '../components/module/form.ts';
import {
  ModuleBanners,
  ModuleHeader,
  ModuleSwitch,
  moduleState,
} from '../components/module/page.tsx';
import type { ModulePageProps } from '../components/module/registry.ts';
import { useModuleToggle } from '../components/module/toggle.ts';
import { Switch } from '../components/ui/controls.tsx';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Rows, Section, SettingRow } from '../components/ui/layout.tsx';
import { SaveBar } from '../components/ui/savebar.tsx';

// Copied, not imported: @proton/module-help only exports ./config, and its barrel pulls discord.js.
const HELP_COLOUR = 0x3369e8;

const HEADING = '## Proton';

const INTRO =
  'Moderation, security and engagement for this server, in one bot. Every action that changes ' +
  'something here is recorded as a numbered case — who did it, to whom, why, and when. Bans, ' +
  'timeouts, role changes and lockdowns can be reversed from that record.';

const CATEGORIES = [
  '**Moderation** — bans, kicks, timeouts, purges and slowmode, and the ladder that escalates ' +
    'repeat warnings.',
  '**Security** — a verification gate for new members, raid and nuke breakers, phishing-link ' +
    'matching, honeypot channels, AutoMod rules and server backups.',
  '**Engagement** — leveling with role rewards, giveaways, a starboard, suggestions, role menus ' +
    'and welcome messages.',
  '**Utility** — tickets, tags, reminders, polls, temporary voice channels, counter channels, ' +
    'join roles, how Proton looks in this server, and which roles may run each command.',
  '**Logging** — Discord’s own audit events routed to the channels you pick, and opt-in message ' +
    'logs kept for 30 days.',
].join('\n');

const WHERE =
  '### Configured in the dashboard\n' +
  'Which modules run in this server, what each one does and who may use them are all set there, ' +
  'not from chat. A change is live here within seconds of being saved.';

const COMMANDS =
  'Type `/` in the message box to see what Proton offers you here. A command you cannot see is ' +
  'either switched off in this server or restricted to another role.';

const OPEN_DASHBOARD = 'Open the dashboard';

function helpPreview(dashboardLink: string): V2Component[] {
  return [
    {
      kind: 'container',
      accentColor: HELP_COLOUR,
      children: [
        { kind: 'text', content: HEADING },
        { kind: 'text', content: INTRO },
        { kind: 'text', content: CATEGORIES },
        { kind: 'separator', divider: true, spacing: 'small' },
        {
          kind: 'section',
          text: [WHERE],
          accessory: {
            kind: 'button',
            button: {
              key: 'help-dashboard',
              style: 'link',
              label: OPEN_DASHBOARD,
              url: dashboardLink,
            },
          },
        },
        { kind: 'text', content: COMMANDS },
      ],
    },
  ];
}

function dashboardLinkFor(guildId: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/dashboard/${guildId}`;
}

export default function HelpPage({ guildId, meta, summary }: ModulePageProps): ReactElement {
  const form = useModuleForm({ guildId, moduleId: meta.id, schema: helpConfigSchema });
  const toggle = useModuleToggle(guildId, summary);

  const enabled = summary?.enabled ?? form.view.enabled;

  return (
    <>
      <ModuleHeader
        meta={meta}
        actions={
          <ModuleSwitch
            name={meta.label}
            enabled={enabled}
            state={summary ? moduleState(summary) : 'off'}
            busy={toggle.busy}
            onToggle={toggle.toggle}
          />
        }
      />

      <ModuleBanners
        guildId={guildId}
        moduleName={meta.label}
        status={summary?.status}
        enabled={enabled}
        migrated={form.view.migrated}
        changedElsewhere={form.changedElsewhere}
        saveError={form.saveError}
      >
        {toggle.failure !== null ? (
          <StatusBanner tone="danger" live="assertive" onDismiss={toggle.dismiss}>
            {toggle.failure}
          </StatusBanner>
        ) : null}
      </ModuleBanners>

      <Section label="Visibility">
        <Rows>
          <SettingRow
            title="Reply privately"
            description="Only the member who used /help sees the reply."
            error={form.errorAt('ephemeral')}
          >
            <Switch
              label="Reply privately"
              checked={form.value.ephemeral}
              onChange={(next) => form.setValue((current) => ({ ...current, ephemeral: next }))}
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section
        label="Message"
        intro="Every server gets the same message; only its visibility can be changed."
      >
        <DiscordPreview message={{ v2: helpPreview(dashboardLinkFor(guildId)) }} botName="Proton" />

        <p className="help-caveat text-sm text-muted">
          The button only appears if Proton knows its dashboard address. Otherwise, /help says so in
          the message.
        </p>
      </Section>

      <SaveBar dirty={form.dirty} saving={form.saving} onSave={form.save} onReset={form.reset} />
    </>
  );
}
