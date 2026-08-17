import type { EventListener, EventType } from '@proton/core';
import type { AutomodConfig } from './config.ts';
import { type AutomodDeps, MODULE_ID } from './deps.ts';
import { syncNativeRules } from './sync.ts';

export const AUTOMOD_SYNC_EVENT_TYPES: EventType[] = ['proton.config_changed', 'guild.available'];

function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

export function createAutomodSyncListener(deps: AutomodDeps): EventListener<AutomodConfig> {
  return {
    types: AUTOMOD_SYNC_EVENT_TYPES,

    async handler(event, ctx) {
      const ourChange = event.type === 'proton.config_changed';
      if (event.guildId === null) return;
      if (ourChange && field(event.payload, 'moduleId') !== MODULE_ID) return;

      const { botUserId, readNativeRules } = deps;
      if (!botUserId || !readNativeRules) {
        // Not an error at info level: a deployment that has not bound the port simply does not do
        // the native half, and saying so on every config save in every guild is noise.
        ctx.logger.warn(
          'Automod is not managing this server’s Discord AutoMod rules: the module was built ' +
            'without readNativeRules or botUserId, so blocked words and presets are enforced only ' +
            'by Proton, after the message is posted.',
          { guildId: ctx.guildId, moduleId: MODULE_ID },
        );
        return;
      }

      // Deliberately not gated on being enabled: switching automod off must take its Discord rules
      // down rather than abandon them still enforcing. The module-level switch is not in the config
      // schema, so it can only be read off the event that announced the change.
      const active = ourChange ? field(event.payload, 'enabledAfter') !== false : true;

      const outcome = await syncNativeRules({ ctx, botUserId, readNativeRules, active });

      for (const failure of outcome.failures) {
        ctx.logger.error(`automod native sync: ${failure}`, {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
      }

      if (outcome.created + outcome.updated + outcome.deleted === 0) return;

      ctx.logger.info(
        `automod native rules reconciled: ${outcome.created} created, ${outcome.updated} ` +
          `updated, ${outcome.deleted} deleted, ${outcome.unchanged} unchanged, ` +
          `${outcome.foreign.length} left alone`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
    },
  };
}
