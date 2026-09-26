import {
  type ApplicationWorkReason,
  applicationWorkRequestedSchema,
  type EntitlementTier,
  type EventBus,
  snowflakeSchema,
} from '@proton/core';
import type { DbHandle } from '@proton/db';
import { auditTrail } from '@proton/db/schema';
import {
  type ApplicationsConfig,
  applicationsConfigSchema,
  type FormConfig,
  reviewSchema,
} from '@proton/module-applications/config';
import { MODULE_ID } from '@proton/module-applications/constants';
import type { EligibilityDeps } from '@proton/module-applications/eligibility';
import { and, eq } from 'drizzle-orm';
import type { ModuleConfigService, ModuleState } from '../modules/service.ts';
import { ApplicationsError } from './errors.ts';

export const HOUR_MS = 60 * 60 * 1000;
export const APPLICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

const CDN = 'https://cdn.discordapp.com';
const NAME_MAX = 100;

export type ModulesPort = Pick<ModuleConfigService, 'get' | 'moduleStates'>;

export interface LoadedConfig {
  config: ApplicationsConfig;
  on: boolean;
  tier: EntitlementTier;
}

export async function loadConfig(modules: ModulesPort, guildId: string): Promise<LoadedConfig> {
  const view = await modules.get(guildId, MODULE_ID);
  const config = applicationsConfigSchema.parse(view.config);
  return { config, on: view.enabled && config.enabled, tier: view.tier };
}

export function modulesOn(states: Readonly<Record<string, ModuleState>>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(states).map(([id, state]) => [id, state.on]));
}

export function eligibilityDeps(
  providers: EligibilityDeps['providers'],
  states: () => Promise<Readonly<Record<string, ModuleState>>>,
): EligibilityDeps {
  let read: Promise<Readonly<Record<string, ModuleState>>> | null = null;

  return {
    providers,
    isEnabled: async (_guildId, moduleId) => {
      read ??= states();
      return (await read)[moduleId]?.on === true;
    },
  };
}

export function assertGuildId(guildId: string): void {
  if (!snowflakeSchema.safeParse(guildId).success) {
    throw new ApplicationsError(
      'invalid_request',
      `${guildId} isn’t a Discord server ID, so nothing was done.`,
    );
  }
}

export function orphanForm(name: string): Pick<FormConfig, 'name' | 'review' | 'interview'> {
  return { name, review: reviewSchema.parse({}), interview: {} };
}

export interface AuditLookup {
  exists(guildId: string, id: string): Promise<boolean>;
}

export function auditTrailLookup(handle: DbHandle): AuditLookup {
  return {
    async exists(guildId, id) {
      const rows = await handle.db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(and(eq(auditTrail.id, id), eq(auditTrail.guildId, guildId)))
        .limit(1);
      return rows.length > 0;
    },
  };
}

export interface WorkRequest {
  guildId: string;
  applicationId?: string | undefined;
  reason: ApplicationWorkReason;
  key: string;
}

export async function requestWork(
  bus: EventBus | undefined,
  logger: Pick<Console, 'warn'>,
  now: number,
  request: WorkRequest,
): Promise<void> {
  if (!bus) return;

  try {
    await bus.publish({
      id: `applications.work_requested:${request.guildId}:${request.key}`,
      type: 'applications.work_requested',
      guildId: request.guildId,
      occurredAt: now,
      payload: applicationWorkRequestedSchema.parse({
        guildId: request.guildId,
        ...(request.applicationId === undefined ? {} : { applicationId: request.applicationId }),
        reason: request.reason,
      }),
    });
  } catch (error) {
    logger.warn(
      `applications work for guild ${request.guildId} was saved, but the worker wasn’t told, so ` +
        `the sweep will pick it up: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function displayNameOf(raw: Record<string, unknown>): string | null {
  const user = record(raw.user);
  const name = text(raw.nick) ?? text(user?.global_name) ?? text(user?.username);
  return name === null ? null : name.slice(0, NAME_MAX);
}

export function usernameOf(raw: Record<string, unknown>): string | null {
  return text(record(raw.user)?.username);
}

export function avatarUrlOf(guildId: string, raw: Record<string, unknown>): string | null {
  const user = record(raw.user);
  const userId = text(user?.id);
  if (userId === null) return null;

  const memberAvatar = text(raw.avatar);
  if (memberAvatar !== null) {
    return `${CDN}/guilds/${guildId}/users/${userId}/avatars/${memberAvatar}.png`;
  }

  const avatar = text(user?.avatar);
  if (avatar !== null) return `${CDN}/avatars/${userId}/${avatar}.png`;

  try {
    return `${CDN}/embed/avatars/${(BigInt(userId) >> 22n) % 6n}.png`;
  } catch {
    return null;
  }
}

export function isBot(raw: Record<string, unknown>): boolean {
  return record(raw.user)?.bot === true;
}

export function guildIconUrl(guildId: string, iconHash: string | null): string | null {
  return iconHash === null ? null : `${CDN}/icons/${guildId}/${iconHash}.png`;
}
