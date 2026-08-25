import type { AutomodConfig } from '@proton/module-automod/config';
import type { EscalationRung } from '@proton/module-cases';
import type { Counter } from '@proton/module-counters/config';
import type { HoneypotChannel } from '@proton/module-honeypot/config';
import type { RoleReward } from '@proton/module-leveling/config';
import type { SavedComponent } from '@proton/module-messages/config';
import type { RolemenuMenu } from '@proton/module-rolemenu/config';
import type { LogEventOverride } from '@proton/module-serverlog/config';
import type { TempVcHub } from '@proton/module-tempvc/config';
import type { TicketPanel, TicketResponse, TicketType } from '@proton/module-tickets/config';
import type { ReactElement } from 'react';
import { EnforcementPanel } from '../automod/enforcement.tsx';
import { CardPreview, GreetingCardPreview } from '../cards/card-preview.tsx';
import { EscalationLadderEditor } from '../cases/escalation-ladder.tsx';
import { CountersEditor } from '../counters/counters.tsx';
import { HoneypotChannelsEditor } from '../honeypot/channels.tsx';
import { LevelUpMessageEditor } from '../leveling/level-up-message.tsx';
import { RoleRewardsEditor } from '../leveling/role-rewards.tsx';
import { PaletteEditor } from '../messages/palette.tsx';
import { type SavedMessageEntry, TemplatesEditor } from '../messages/templates.tsx';
import { RolemenuEditor } from '../rolemenu/menus.tsx';
import { LogEventMatrix } from '../serverlog/event-matrix.tsx';
import { HubsEditor } from '../tempvc/hubs.tsx';
import { TicketPanelsEditor } from '../tickets/panels.tsx';
import { TicketResponsesEditor } from '../tickets/responses.tsx';
import { TicketTypesEditor } from '../tickets/types.tsx';
import { GreetingEditor } from '../welcome/greeting.tsx';
import type { PanelProps } from './registry.ts';

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord<T>(value: unknown): Record<string, T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, T>;
}

export function RankCardPreviewPanel({ guildId, liveConfig }: PanelProps): ReactElement {
  return (
    <CardPreview
      config={liveConfig}
      guildId={guildId}
      kind="rank"
      presetKey="cardPreset"
      toggles={{
        cardShowRank: 'showRank',
        cardShowPercent: 'showPercent',
        cardShowTotalXp: 'showTotalXp',
      }}
    />
  );
}

export function GreetingCardPreviewPanel({ guildId, liveConfig }: PanelProps): ReactElement {
  return <GreetingCardPreview config={liveConfig} guildId={guildId} />;
}

export function EscalationLadderPanel({ value, onChange }: PanelProps): ReactElement {
  return <EscalationLadderEditor rungs={asArray<EscalationRung>(value)} onChange={onChange} />;
}

export function RoleRewardsPanel({ value, onChange, roles }: PanelProps): ReactElement {
  return (
    <RoleRewardsEditor rewards={asArray<RoleReward>(value)} roles={roles} onChange={onChange} />
  );
}

export function LevelUpMessagePanel({
  value,
  onChange,
  channels,
  roles,
}: PanelProps): ReactElement {
  return (
    <LevelUpMessageEditor channels={channels} message={value} onChange={onChange} roles={roles} />
  );
}

export function RoleMenusPanel({ value, onChange, roles, channels }: PanelProps): ReactElement {
  return (
    <RolemenuEditor
      menus={asArray<RolemenuMenu>(value)}
      roles={roles}
      channels={channels}
      onChange={onChange}
    />
  );
}

export function EnforcementReadout({ liveConfig }: PanelProps): ReactElement {
  return <EnforcementPanel config={liveConfig as unknown as AutomodConfig} />;
}

export function LogEventsPanel({
  value,
  onChange,
  channels,
  liveConfig,
}: PanelProps): ReactElement {
  return (
    <LogEventMatrix
      events={asRecord<LogEventOverride>(value)}
      channels={channels}
      defaultChannelId={String(liveConfig.defaultChannelId ?? '')}
      categoryChannels={asRecord<string>(liveConfig.categoryChannels)}
      categories={asRecord<boolean>(liveConfig.categories)}
      onChange={onChange}
    />
  );
}

export function TicketResponsesPanel({ value, onChange }: PanelProps): ReactElement {
  return <TicketResponsesEditor onChange={onChange} responses={asArray<TicketResponse>(value)} />;
}

export function TicketTypesPanel({
  value,
  onChange,
  channels,
  roles,
  tier,
}: PanelProps): ReactElement {
  return (
    <TicketTypesEditor
      channels={channels}
      onChange={onChange}
      roles={roles}
      tier={tier}
      types={asArray<TicketType>(value)}
    />
  );
}

export function TicketPanelsPanel({
  value,
  onChange,
  channels,
  liveConfig,
  tier,
}: PanelProps): ReactElement {
  return (
    <TicketPanelsEditor
      channels={channels}
      onChange={onChange}
      panels={asArray<TicketPanel>(value)}
      tier={tier}
      // The saved types, not the ones being edited beside this: nothing carries an unsaved panel
      // value across to another panel, so the picker would otherwise offer a type that is not
      // stored yet and drop one that is.
      types={asArray<TicketType>(liveConfig.types)}
    />
  );
}

export function TempVcHubsPanel({
  value,
  onChange,
  channels,
  roles,
  tier,
}: PanelProps): ReactElement {
  return (
    <HubsEditor
      hubs={asArray<TempVcHub>(value)}
      channels={channels}
      roles={roles}
      tier={tier}
      onChange={onChange}
    />
  );
}

export function TemplatesPanel({
  value,
  onChange,
  channels,
  roles,
  liveConfig,
  tier,
}: PanelProps): ReactElement {
  return (
    <TemplatesEditor
      channels={channels}
      onChange={onChange}
      // Live, not the stored config: a component saved in the palette should be insertable in the
      // same visit, before either half has been saved.
      palette={asArray<SavedComponent>(liveConfig.components)}
      roles={roles}
      templates={asArray<SavedMessageEntry>(value)}
      tier={tier}
    />
  );
}

export function PalettePanel({ value, onChange, roles }: PanelProps): ReactElement {
  return (
    <PaletteEditor components={asArray<SavedComponent>(value)} onChange={onChange} roles={roles} />
  );
}

export function CountersPanel({ value, onChange, channels, tier }: PanelProps): ReactElement {
  return (
    <CountersEditor
      counters={asArray<Counter>(value)}
      channels={channels}
      tier={tier}
      onChange={onChange}
    />
  );
}

export function HoneypotChannelsPanel({
  value,
  onChange,
  channels,
  tier,
}: PanelProps): ReactElement {
  return (
    <HoneypotChannelsEditor
      channels={channels}
      honeypots={asArray<Partial<HoneypotChannel>>(value)}
      tier={tier}
      onChange={onChange}
    />
  );
}

export function WelcomeMessagePanel({
  value,
  onChange,
  channels,
  roles,
}: PanelProps): ReactElement {
  return (
    <GreetingEditor
      channels={channels}
      description="Posted in the welcome channel when somebody joins."
      message={value}
      onChange={onChange}
      roles={roles}
    />
  );
}

export function GoodbyeMessagePanel({
  value,
  onChange,
  channels,
  roles,
}: PanelProps): ReactElement {
  return (
    <GreetingEditor
      channels={channels}
      description="Posted in the goodbye channel when somebody leaves."
      message={value}
      onChange={onChange}
      roles={roles}
    />
  );
}
