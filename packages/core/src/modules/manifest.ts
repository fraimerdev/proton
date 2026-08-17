import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord-api-types/v10';
import type { z } from 'zod';
import type { ActionExecutor } from '../actions/types.ts';
import type { EventType, ProtonEvent } from '../events/types.ts';
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

  publish?(type: EventType, naturalKey: string, payload: unknown): Promise<void>;
}

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

  rules?: RuleDefinition[];

  // The same rules recompiled from a guild's own config, run on every save. `rules` alone is
  // seeded once from defaults, so without this an edited escalation ladder changes nothing.
  // Pure and returning data, so what it produces is still inspectable and diffable.
  compileRules?(config: z.infer<C>): RuleDefinition[];
  jobs?: ScheduledJob[];
  dashboard?: { icon: string; sections: SectionDescriptor[] };
}
