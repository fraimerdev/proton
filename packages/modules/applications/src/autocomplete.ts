import {
  type AutocompleteChoice,
  type EventListener,
  type EventType,
  interactionRef,
  MAX_AUTOCOMPLETE_CHOICE_LENGTH,
  MAX_AUTOCOMPLETE_CHOICES,
  type ModuleContext,
  type ProtonEvent,
  readAutocompleteInteraction,
  respondAutocomplete,
} from '@proton/core';
import type { ApplicationsConfig, Requirements } from './config.ts';
import { MODULE_ID } from './constants.ts';
import type { ApplicationsDeps } from './deps.ts';
import { intakeState } from './intake.ts';
import { clip } from './modal.ts';
import { STATUS_LABELS } from './status.ts';
import type { ApplicationRecord, FormVersionRecord } from './store.ts';
import { canWithdraw, referenceOf } from './web.ts';

export const APPLY_COMMAND = 'apply';
export const FORM_OPTION = 'form';
export const APPLICATION_OPTION = 'application';

export const AUTOCOMPLETE_EVENT_TYPES: EventType[] = ['interaction.autocomplete'];

function matches(query: string, ...candidates: string[]): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || candidates.some((candidate) => candidate.toLowerCase().includes(needle));
}

// Only what the press itself carries: provider checks (level, cases, ages) wait for the overview.
export function rolesAllow(requirements: Requirements, roleIds: readonly string[] | null): boolean {
  if (roleIds === null) return true;

  const held = new Set(roleIds);
  if (requirements.blockedRoleIds.some((roleId) => held.has(roleId))) return false;
  if (requirements.roleIds.length === 0) return true;

  return requirements.roleMode === 'all'
    ? requirements.roleIds.every((roleId) => held.has(roleId))
    : requirements.roleIds.some((roleId) => held.has(roleId));
}

export function formChoices(
  config: ApplicationsConfig,
  published: ReadonlyMap<string, FormVersionRecord>,
  roleIds: readonly string[] | null,
  now: number,
  query: string,
): AutocompleteChoice[] {
  return config.forms
    .filter((form) => {
      const version = published.get(form.id);
      if (version === undefined) return false;

      const intake = intakeState({ moduleOn: config.enabled, form, published: true, now });
      return (
        intake.state === 'open' &&
        rolesAllow(version.snapshot.requirements, roleIds) &&
        matches(query, form.id, version.snapshot.name)
      );
    })
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((form) => ({
      name: clip(
        published.get(form.id)?.snapshot.name ?? form.name,
        MAX_AUTOCOMPLETE_CHOICE_LENGTH,
      ),
      value: form.id,
    }));
}

export function applicationChoices(
  config: ApplicationsConfig,
  rows: readonly ApplicationRecord[],
  query: string,
): AutocompleteChoice[] {
  return rows
    .filter((row) => row.deletedAt === null && row.number !== null && canWithdraw(row.status))
    .map((row) => {
      const formName = config.forms.find((form) => form.id === row.formId)?.name ?? row.formId;
      const reference = referenceOf(row.number);
      return { row, formName, reference };
    })
    .filter(({ formName, reference }) => matches(query, reference, reference.slice(1), formName))
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map(({ row, formName, reference }) => ({
      name: clip(
        `${reference} · ${formName} · ${STATUS_LABELS[row.status]}`,
        MAX_AUTOCOMPLETE_CHOICE_LENGTH,
      ),
      value: row.id,
    }));
}

function rolesOf(event: ProtonEvent): string[] | null {
  const payload = event.payload as { member?: { roles?: unknown } } | null;
  const roles = payload?.member?.roles;
  return Array.isArray(roles) ? roles.filter((id): id is string => typeof id === 'string') : null;
}

export async function answerAutocomplete(
  event: ProtonEvent,
  ctx: ModuleContext<ApplicationsConfig>,
  deps: ApplicationsDeps,
): Promise<AutocompleteChoice[] | null> {
  const facts = readAutocompleteInteraction(event);
  if (facts === null || facts.commandName !== APPLY_COMMAND || facts.focused === null) return null;

  const { focused } = facts;
  let choices: AutocompleteChoice[] = [];

  if (ctx.config.enabled && deps.store !== undefined) {
    const now = deps.now?.() ?? Date.now();
    try {
      if (focused.name === FORM_OPTION) {
        const published = await deps.store.latestVersions(ctx.guildId);
        choices = formChoices(ctx.config, published, rolesOf(event), now, focused.value);
      } else if (focused.name === APPLICATION_OPTION) {
        const rows = await deps.store.mine(ctx.guildId, facts.userId);
        choices = applicationChoices(ctx.config, rows, focused.value);
      }
    } catch (error) {
      const line = error instanceof Error ? (error.message.split('\n')[0] ?? '') : 'unknown';
      ctx.logger.warn(
        `applications could not list choices for /${APPLY_COMMAND}: ${line.slice(0, 200)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      choices = [];
    }
  }

  const result = await ctx.executor.execute(
    respondAutocomplete(
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        actorId: facts.userId,
        interaction: interactionRef(facts),
        idempotencyKey: `${MODULE_ID}:${event.id}`,
      },
      choices,
    ),
  );
  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `applications could not answer an autocomplete: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }

  return choices;
}

export function createApplicationsAutocompleteListener(
  deps: ApplicationsDeps,
): EventListener<ApplicationsConfig> {
  return {
    types: AUTOCOMPLETE_EVENT_TYPES,
    async handler(event, ctx) {
      await answerAutocomplete(event, ctx, deps);
    },
  };
}
