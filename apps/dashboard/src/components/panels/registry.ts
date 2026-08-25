import type { EntitlementTier, FieldDescriptor } from '@proton/core';
import { EMPTY_MESSAGE, zodToDescriptors } from '@proton/core';
import { escalationLadderSchema } from '@proton/module-cases';
import { honeypotChannelsSchema } from '@proton/module-honeypot/config';
import { roleRewardsSchema } from '@proton/module-leveling/config';
import { commandOverridesFormSchema } from '@proton/module-permissions';
import { rolemenuMenusSchema } from '@proton/module-rolemenu/config';
import { tempVcHubsSchema } from '@proton/module-tempvc/config';
import {
  ticketPanelsSchema,
  ticketResponsesSchema,
  ticketTypesSchema,
} from '@proton/module-tickets/config';
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
  | 'TicketResponsesPanel'
  | 'TicketTypesPanel'
  | 'WelcomeMessagePanel';

export interface PanelProps {
  value: unknown;
  onChange: (value: unknown) => void;
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  liveConfig: Record<string, unknown>;

  // What this server may actually hold. The config schemas cap at the pro ceiling because they are
  // tier-agnostic; the API refuses anything above the real one at save time.
  tier: EntitlementTier;

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

      // The same schema the panel already safeParses to draw its own error list. Held here too so
      // Save can be gated on it: a panel belonging to another area never mounts to report upward.
      schema?: z.ZodType;
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
        schema: escalationLadderSchema,
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
        schema: roleRewardsSchema,
        Panel: panel('RoleRewardsPanel'),
      },
      { key: null, title: 'Rank card preview', Panel: panel('RankCardPreviewPanel') },
    ],
  },
  rolemenu: {
    panels: [
      {
        key: 'menus',
        emptyValue: [],
        title: 'Role menus',
        Panel: panel('RoleMenusPanel'),
        schema: rolemenuMenusSchema,
      },
    ],
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
        schema: honeypotChannelsSchema,
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
      // Before panels, because a panel has nothing to offer until a type exists.
      {
        key: 'types',
        emptyValue: [],
        title: 'Ticket types',
        Panel: panel('TicketTypesPanel'),
        schema: ticketTypesSchema,
      },
      {
        key: 'panels',
        emptyValue: [],
        title: 'Ticket panels',
        Panel: panel('TicketPanelsPanel'),
        schema: ticketPanelsSchema,
      },
      {
        key: 'responses',
        emptyValue: [],
        title: 'Saved replies',
        Panel: panel('TicketResponsesPanel'),
        schema: ticketResponsesSchema,
      },
    ],
  },
  tempvc: {
    panels: [
      {
        key: 'hubs',
        emptyValue: [],
        title: 'Hubs',
        Panel: panel('TempVcHubsPanel'),
        schema: tempVcHubsSchema,
      },
    ],
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

/**
 * The first panel whose values do not satisfy its own schema, over the whole module rather than the
 * area on screen. Save writes every panel's values, so a hub left half-filled on another area was
 * being written by a Save pressed here.
 */
export function invalidPanelOf(
  moduleId: string,
  values: Record<string, unknown>,
): { key: string; title: string } | undefined {
  const spec = specFor(moduleId);
  if (!spec) return undefined;

  for (const entry of spec.panels) {
    if (entry.key === null || entry.schema === undefined) continue;
    if (!entry.schema.safeParse(values[entry.key]).success)
      return { key: entry.key, title: entry.title };
  }

  return undefined;
}
