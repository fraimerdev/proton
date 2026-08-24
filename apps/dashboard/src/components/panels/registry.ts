import type { FieldDescriptor } from '@proton/core';
import { EMPTY_MESSAGE, zodToDescriptors } from '@proton/core';
import { commandOverridesFormSchema } from '@proton/module-permissions';
import { lazyRouteComponent } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { z } from 'zod';
import type { DiscordChannel, DiscordRole } from '../form/fields.tsx';

// Lazy, and preloaded by the module loader. Seventeen of the twenty-seven modules register no
// panel at all, and a static import here put all ten editors on every one of their settings pages.
function panel(name: PanelExport): PanelComponent {
  return lazyRouteComponent(() => import('./panels.tsx'), name);
}

type PanelExport =
  | 'CountersPanel'
  | 'EnforcementReadout'
  | 'GreetingCardPreviewPanel'
  | 'RankCardPreviewPanel'
  | 'EscalationLadderPanel'
  | 'GoodbyeMessagePanel'
  | 'HoneypotChannelsPanel'
  | 'LevelUpMessagePanel'
  | 'LogEventsPanel'
  | 'RoleMenusPanel'
  | 'RoleRewardsPanel'
  | 'PalettePanel'
  | 'TemplatesPanel'
  | 'TempVcHubsPanel'
  | 'TicketPanelsPanel'
  | 'WelcomeMessagePanel';

export interface PanelProps {
  value: unknown;
  onChange: (value: unknown) => void;
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  liveConfig: Record<string, unknown>;

  guildId: string;
}

export type PanelComponent = ComponentType<PanelProps> & {
  preload?: (() => Promise<void> | undefined) | undefined;
};

export type PanelEntry =
  | {
      key: string;
      emptyValue: unknown;
      title: string;
      Panel: PanelComponent;
    }
  | {
      key: null;
      title: string;
      Panel: PanelComponent;
    };

export interface ModulePanels {
  panels: readonly PanelEntry[];
  descriptors?: (commands: readonly string[]) => FieldDescriptor[];
  transform?: (config: Record<string, unknown>) => Record<string, unknown>;
}

function prunedOverrides(overrides: unknown): Record<string, unknown> {
  if (typeof overrides !== 'object' || overrides === null) return {};

  return Object.fromEntries(
    Object.entries(overrides as Record<string, unknown>).filter(
      ([, roles]) => !Array.isArray(roles) || roles.length > 0,
    ),
  );
}

export const MODULE_PANELS: Readonly<Record<string, ModulePanels>> = {
  cases: {
    panels: [
      {
        key: 'escalationLadder',
        emptyValue: [],
        title: 'Warn escalation',
        Panel: panel('EscalationLadderPanel'),
      },
    ],
  },
  leveling: {
    panels: [
      {
        key: 'levelUpMessage',
        emptyValue: EMPTY_MESSAGE,
        title: 'Level-up message',
        Panel: panel('LevelUpMessagePanel'),
      },
      {
        key: 'roleRewards',
        emptyValue: [],
        title: 'Role rewards',
        Panel: panel('RoleRewardsPanel'),
      },
      { key: null, title: 'Rank card preview', Panel: panel('RankCardPreviewPanel') },
    ],
  },
  rolemenu: {
    panels: [{ key: 'menus', emptyValue: [], title: 'Role menus', Panel: panel('RoleMenusPanel') }],
  },
  automod: {
    panels: [{ key: null, title: 'Who enforces what', Panel: panel('EnforcementReadout') }],
  },
  honeypot: {
    panels: [
      {
        key: 'channels',
        emptyValue: [],
        title: 'Honeypot channels',
        Panel: panel('HoneypotChannelsPanel'),
      },
    ],
  },
  serverlog: {
    panels: [
      { key: 'events', emptyValue: {}, title: 'Individual logs', Panel: panel('LogEventsPanel') },
    ],
  },
  tickets: {
    panels: [
      { key: 'panels', emptyValue: [], title: 'Ticket panels', Panel: panel('TicketPanelsPanel') },
    ],
  },
  tempvc: {
    panels: [{ key: 'hubs', emptyValue: [], title: 'Hubs', Panel: panel('TempVcHubsPanel') }],
  },
  messages: {
    panels: [
      { key: 'templates', emptyValue: [], title: 'Templates', Panel: panel('TemplatesPanel') },
      { key: 'components', emptyValue: [], title: 'Components', Panel: panel('PalettePanel') },
    ],
  },
  welcome: {
    panels: [
      {
        key: 'welcomeMessage',
        emptyValue: EMPTY_MESSAGE,
        title: 'Welcome message',
        Panel: panel('WelcomeMessagePanel'),
      },
      {
        key: 'goodbyeMessage',
        emptyValue: EMPTY_MESSAGE,
        title: 'Goodbye message',
        Panel: panel('GoodbyeMessagePanel'),
      },
      { key: null, title: 'Card preview', Panel: panel('GreetingCardPreviewPanel') },
    ],
  },
  counters: {
    panels: [
      { key: 'counters', emptyValue: [], title: 'Counter channels', Panel: panel('CountersPanel') },
    ],
  },
  permissions: {
    panels: [],
    descriptors: (commands) =>
      zodToDescriptors(z.object({ overrides: commandOverridesFormSchema(commands) })),
    transform: (config) => ({ ...config, overrides: prunedOverrides(config.overrides) }),
  },
};

// Object.hasOwn, not a lookup-and-test: MODULE_PANELS['constructor'] would otherwise be truthy.
function specFor(moduleId: string): ModulePanels | undefined {
  return Object.hasOwn(MODULE_PANELS, moduleId) ? MODULE_PANELS[moduleId] : undefined;
}

export function panelsFor(moduleId: string): readonly PanelEntry[] {
  return specFor(moduleId)?.panels ?? [];
}

export function panelDescriptors(moduleId: string, commands: readonly string[]): FieldDescriptor[] {
  return specFor(moduleId)?.descriptors?.(commands) ?? [];
}

export function initialPanelValues(
  moduleId: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const entry of panelsFor(moduleId)) {
    if (entry.key === null) continue;
    values[entry.key] = config[entry.key] ?? entry.emptyValue;
  }

  return values;
}

export function applyPanels(
  moduleId: string,
  config: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const spec = specFor(moduleId);
  if (!spec) return config;

  const next = { ...config };
  for (const entry of spec.panels) {
    if (entry.key !== null) next[entry.key] = values[entry.key];
  }

  return spec.transform ? spec.transform(next) : next;
}
