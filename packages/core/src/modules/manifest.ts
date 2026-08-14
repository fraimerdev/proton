import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord-api-types/v10';
import type { z } from 'zod';
import type { ActionExecutor } from '../actions/types.ts';
import type { EventType, ProtonEvent } from '../events/types.ts';
import type { CommandOptions } from './options.ts';

export type ModuleCategory = 'moderation' | 'security' | 'engagement' | 'utility' | 'logging';

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * What a module is handed at runtime.
 *
 * Deliberately narrow: no bus, no database, no registry. A module cannot reach
 * another module's data or publish arbitrary events, which is what makes I3
 * ("modules never import each other") enforceable rather than merely a
 * convention someone will eventually break.
 */
export interface ModuleContext<C = unknown> {
  guildId: string;
  config: C;
  executor: ActionExecutor;
  logger: Logger;
}

export interface CommandContext<C = unknown> extends ModuleContext<C> {
  channelId: string;
  userId: string;
  /** Typed slash-command options. Every command but `ping` needs these. */
  options: CommandOptions;
  interaction: { id: string; token: string };
  /**
   * Derived from the originating event id, so a redelivered interaction reuses
   * the same key and the executor dedupes it (I4).
   */
  idempotencyKey: string;
}

export interface CommandDefinition<C = unknown> {
  name: string;
  description: string;
  /** Registration payload — typically `new SlashCommandBuilder()...toJSON()`. */
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  handler(ctx: CommandContext<C>): Promise<void>;
}

export interface EventListener<C = unknown> {
  types: EventType[];
  handler(event: ProtonEvent, ctx: ModuleContext<C>): Promise<void>;
}

/** Modules own their own tables (PLAN.md §7). */
export interface Migration {
  id: string;
  sql: string;
}

export interface SectionDescriptor {
  id: string;
  title: string;
  /** Config paths shown in this section; empty means "everything not claimed". */
  fields: string[];
}

/**
 * PLAN.md §7.
 *
 * `rules` and `jobs` from the spec are not present yet: the rule engine (P2) and
 * BullMQ arrive in Phase 1, so those fields would reference types with no
 * implementation and no consumer. Adding them later is a pure type widening and
 * breaks no existing manifest. See plan deviation D13.
 */
export interface ModuleManifest<C extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  id: string;
  name: string;
  category: ModuleCategory;
  configSchema: C;
  defaultConfig: z.infer<C>;
  /** Bumped whenever `configSchema` changes shape (I5). */
  schemaVersion: number;
  requiredIntents: number[];
  requiredPermissions: bigint[];
  requiredEntitlement?: 'free' | 'plus' | 'pro';
  dependsOn?: string[];
  commands?: CommandDefinition<z.infer<C>>[];
  listeners?: EventListener<z.infer<C>>[];
  migrations: Migration[];
  dashboard?: { icon: string; sections: SectionDescriptor[] };
}
