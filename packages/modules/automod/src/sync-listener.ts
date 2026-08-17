import type { EventListener, EventType } from '@proton/core';
import type { AutomodConfig } from './config.ts';
import { type AutomodDeps, MODULE_ID } from './deps.ts';
import { syncNativeRules } from './sync.ts';

export const AUTOMOD_SYNC_EVENT_TYPES: EventType[] = ['proton.config_changed', 'guild.available'];

function isOurConfigChange(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { moduleId?: unknown }).moduleId === MODULE_ID
  );
}

export function createAutomodSyncListener(deps: AutomodDeps): EventListener<AutomodConfig> {
  return {
    types: AUTOMOD_SYNC_EVENT_TYPES,

    async handler(event, ctx) {
      if (event.guildId === null) return;
      if (event.type === 'proton.config_changed' && !isOurConfigChange(event.payload)) return;

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

      // Deliberately not gated on ctx.config.enabled: disabling automod must take its rules down
      // rather than abandon them, and planNativeRules returns nothing for a disabled config, which
      // makes the diff a delete of everything Proton owns.
      const outcome = await syncNativeRules({ ctx, botUserId, readNativeRules });

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
