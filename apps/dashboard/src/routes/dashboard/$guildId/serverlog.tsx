import type { LogEventOverride } from '@proton/module-serverlog/config';
import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SectionCard } from '../../../components/form/section.tsx';
import { SERVERLOG_AREAS as AREAS } from '../../../components/module/area-index.ts';
import { activeArea } from '../../../components/module/areas.ts';
import type { ModuleForm } from '../../../components/module/form.ts';
import { useModuleForm } from '../../../components/module/form.ts';
import { ChannelField, Toggle, Tokens } from '../../../components/module/inputs.tsx';
import { AreaHub, ModuleChrome, ModuleSettings } from '../../../components/module/page.tsx';
import { moduleRoute } from '../../../components/module/route.tsx';

const LogEventMatrix = lazyRouteComponent(
  () => import('../../../components/serverlog/event-matrix.tsx'),
  'LogEventMatrix',
);

const LOG_CHANNEL_TYPES = [0, 5];

const CATEGORIES = [
  { key: 'server', label: 'Server', on: true },
  { key: 'channels', label: 'Channels', on: true },
  { key: 'roles', label: 'Roles', on: true },
  { key: 'members', label: 'Members', on: true },
  { key: 'messages', label: 'Messages', on: false },
  { key: 'voice', label: 'Voice', on: false },
  { key: 'moderation', label: 'Moderation', on: true },
  { key: 'invites', label: 'Invites', on: true },
  { key: 'integrations', label: 'Integrations', on: true },
  { key: 'expressions', label: 'Emoji & stickers', on: true },
  { key: 'events', label: 'Events & stages', on: true },
  { key: 'automod', label: 'AutoMod', on: true },
  { key: 'proton', label: 'Proton', on: true },
] as const;

export const Route = createFileRoute('/dashboard/$guildId/serverlog')({
  ...moduleRoute('serverlog', { areas: AREAS, preload: [LogEventMatrix] }),
  component: ServerlogPage,
});

function ServerlogPage(): ReactElement {
  const { guildId } = Route.useParams();
  const search = Route.useSearch();
  const form = useModuleForm(guildId, 'serverlog', true);

  const area = activeArea(AREAS, search.area);

  return (
    <>
      <ModuleChrome guildId={guildId} summary={form.summary} area={area} tabs={[]} />

      {area === undefined ? (
        <AreaHub areas={AREAS} config={form.config} />
      ) : (
        <ModuleSettings form={form}>
          {area.id === 'routing' ? <RoutingArea /> : null}
          {area.id === 'events' ? <EventsArea form={form} /> : null}
          {area.id === 'filters' ? <FiltersArea /> : null}
        </ModuleSettings>
      )}
    </>
  );
}

function RoutingArea(): ReactElement {
  return (
    <>
      <SectionCard id="serverlog:general" title="General">
        <ChannelField
          path="defaultChannelId"
          label="Default log channel"
          help="Category and per-event channels override this"
          channelTypes={LOG_CHANNEL_TYPES}
          defaultValue=""
        />
      </SectionCard>

      <SectionCard id="serverlog:categories" title="Categories">
        {/* Two parallel objects over one set of keys, drawn as the table they are. As plain rows
            this section was every category's switch followed by every category's channel —
            twenty-six rows carrying thirteen labels twice, with a category's two halves a full
            screen apart. */}
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Logged</th>
              <th scope="col">Channel</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map((category) => (
              <tr key={category.key}>
                <th scope="row">{category.label}</th>

                {/* data-label is read back as the cell's own visible label once the table reflows
                    to a block per row on a phone and the column headers stop being above
                    anything. */}
                <td data-kind="boolean" data-label="Logged">
                  <Toggle
                    path={`categories.${category.key}`}
                    label={category.label}
                    defaultValue={category.on}
                    // Named per cell: every control in a column carries the same label, and a row
                    // of switches all called "Logged" is a row nobody can navigate by ear.
                    param={{ label: undefined, name: `${category.label} — Logged` }}
                  />
                </td>

                <td data-kind="channel-id" data-label="Channel">
                  <ChannelField
                    path={`categoryChannels.${category.key}`}
                    label={category.label}
                    channelTypes={LOG_CHANNEL_TYPES}
                    defaultValue=""
                    param={{
                      label: undefined,
                      name: `${category.label} — Channel`,
                      emptyLabel: 'Inherit',
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </>
  );
}

function asRecord<T>(value: unknown): Record<string, T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, T>;
}

function EventsArea({ form }: { form: ModuleForm }): ReactElement {
  const live = form.live;

  return (
    <SectionCard id="serverlog:panel:events" title={null}>
      <LogEventMatrix
        events={asRecord<LogEventOverride>(form.value('events', {}))}
        channels={form.channels}
        // Live, not stored: these three draw what each row inherits, and the stored config shows
        // the old channel while an unsaved edit on the routing area is what the reader just made.
        defaultChannelId={String(live.defaultChannelId ?? '')}
        categoryChannels={asRecord<string>(live.categoryChannels)}
        categories={asRecord<boolean>(live.categories)}
        onChange={(next) => form.set('events', next)}
      />
    </SectionCard>
  );
}

function FiltersArea(): ReactElement {
  return (
    <SectionCard id="serverlog:filters" title="Filters">
      <Tokens path="ignoredChannelIds" kind="channel-id" label="Ignored channels" maxItems={100} />
      <Tokens path="ignoredRoleIds" kind="role-id" label="Ignored roles" maxItems={50} />
      <Tokens path="ignoredUserIds" kind="string" label="Ignored user ids" maxItems={100} />
      <Toggle path="ignoreBots" label="Ignore bots" defaultValue={false} />
    </SectionCard>
  );
}
