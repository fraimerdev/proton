import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord-api-types/v10';
import type { z } from 'zod';
import type { ActionKind } from '../actions/kinds.ts';
import type { ScheduleOptions, ScheduleOutcome } from '../actions/scheduled-actions.ts';
import type { ActionExecutor } from '../actions/types.ts';
import type { LimitKey } from '../entitlements/limits.ts';
import type { EventType, ProtonEvent } from '../events/types.ts';
import type { Provider } from '../providers/types.ts';
import type { EntitlementTier } from '../rules/facts.ts';
import type { RuleDefinition, ScheduledJob } from '../rules/types.ts';
import type { CommandOptions } from './options.ts';

export type ModuleCategory = 'moderation' | 'security' | 'engagement' | 'utility' | 'logging';

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ModuleContext<C = unknown> {
  guildId: string;
  config: C;
  executor: ActionExecutor;
  logger: Logger;

  // Optional so a test harness can build a context without knowing about billing; every consumer
  // reads it as 'free' when absent, which is what an unbilled guild is.
  tier?: EntitlementTier;

  publish?(type: EventType, naturalKey: string, payload: unknown): Promise<void>;

  schedule?(
    jobId: string,
    runAt: Date,
    naturalKey: string,
    data?: unknown,
    options?: ScheduleOptions,
  ): Promise<ScheduleOutcome>;
  cancel?(jobId: string, naturalKey: string): Promise<void>;
}

export type ScheduledHandler<C = unknown> = (data: unknown, ctx: ModuleContext<C>) => Promise<void>;

export interface CommandContext<C = unknown> extends ModuleContext<C> {
  channelId: string;
  userId: string;

  options: CommandOptions;
  interaction: { id: string; token: string };

  idempotencyKey: string;
}

export interface CommandDefinition<C = unknown> {
  name: string;
  description: string;

  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  handler(ctx: CommandContext<C>): Promise<void>;
}

export interface EventListener<C = unknown> {
  types: EventType[];
  handler(event: ProtonEvent, ctx: ModuleContext<C>): Promise<void>;
}

// A list an admin authors in the dashboard cannot be refused by the module — modules read config
// and never write it — so the tier cap has to be enforced where the save happens.
export interface ConfigLimit {
  key: LimitKey;

  path: string;
}

export interface SectionDescriptor {
  id: string;
  title: string;

  fields: string[];
}

export interface ModuleManifest<C extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  id: string;
  name: string;
  category: ModuleCategory;
  configSchema: C;

  formSchema?: z.ZodObject<z.ZodRawShape>;
  defaultConfig: z.infer<C>;

  schemaVersion: number;
  requiredIntents: number[];
  requiredPermissions: bigint[];
  requiredEntitlement?: 'free' | 'plus' | 'pro';
  dependsOn?: string[];
  commands?: CommandDefinition<z.infer<C>>[];
  listeners?: EventListener<z.infer<C>>[];

  emits?: EventType[];

  // Not documentation: invitePermissions() is derived from this, so a kind omitted here is a
  // permission the bot is never invited with and an action that silently fails its precheck.
  actionKinds?: ActionKind[];

  configLimits?: ConfigLimit[];

  schedules?: string[];
  scheduledHandlers?: Record<string, ScheduledHandler<z.infer<C>>>;

  // Condition and multiplier providers this module owns. A module may only register providers
  // namespaced to its own id, which is what lets giveaways consume leveling's without importing it.
  providers?: Provider[];

  rules?: RuleDefinition[];

  // The same rules recompiled from a guild's own config, run on every save. `rules` alone is
  // seeded once from defaults, so without this an edited escalation ladder changes nothing.
  // Pure and returning data, so what it produces is still inspectable and diffable.
  compileRules?(config: z.infer<C>): RuleDefinition[];

  // Run over a stored config before it is parsed, for a module that has renamed a key. configSchema
  // has to stay a ZodObject for the form generator, so the lift cannot be a z.preprocess wrapped
  // around it — and without one, Zod strips the old key and the next write persists the loss.
  liftStoredConfig?(raw: unknown): unknown;
  jobs?: ScheduledJob[];
  dashboard?: { icon: string; sections: SectionDescriptor[] };
}
