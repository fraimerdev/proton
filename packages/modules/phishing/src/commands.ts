import { type CommandDefinition, formatDuration, type Logger, Permissions } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { PhishingConfig } from './config.ts';
import { bindDeps, describeUnbound, type PhishingDeps } from './deps.ts';
import { MODULE_ID } from './listener.ts';
import type { BlocklistStats } from './store.ts';

const NOT_WIRED =
  "I can't tell you the state of the phishing blocklist because Proton isn't fully wired up " +
  'in this deployment. The Proton logs name the exact missing piece.';

export function createPhishingStatusCommand(deps: PhishingDeps): CommandDefinition<PhishingConfig> {
  return {
    name: 'phishing',
    description: 'Show the state of the phishing blocklist in this server.',

    data: new SlashCommandBuilder()
      .setName('phishing')
      .setDescription('Show the state of the phishing blocklist in this server.')
      .setContexts(InteractionContextType.Guild)

      .setDefaultMemberPermissions(Permissions.ManageGuild)
      .toJSON(),

    async handler(ctx) {
      const bound = bindDeps(deps);

      if ('unbound' in bound) {
        ctx.logger.error(describeUnbound(bound.unbound), {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
      }

      const body =
        'unbound' in bound
          ? NOT_WIRED
          : await describeStats(bound.deps.blocklist.stats(), ctx.config, ctx.logger);

      const result = await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'interaction_reply',
        actorId: ctx.userId,
        idempotencyKey: `${ctx.idempotencyKey}:reply`,
        dryRun: false,
        payload: {
          interactionId: ctx.interaction.id,
          interactionToken: ctx.interaction.token,
          content: body.slice(0, 2000),

          ephemeral: true,
        },
      });

      if (result.status === 'failed_precheck' || result.status === 'failed_api') {
        ctx.logger.warn(
          `phishing could not answer /phishing: ${
            result.failure?.humanReason ?? 'no reason was reported'
          }`,
          { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
        );
      }
    },
  };
}

async function describeStats(
  pending: Promise<BlocklistStats>,
  config: PhishingConfig,
  logger: Logger,
): Promise<string> {
  let stats: BlocklistStats;
  try {
    stats = await pending;
  } catch (error) {
    logger.error(
      `the blocklist cache could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { moduleId: MODULE_ID },
    );

    return (
      'I could not read the phishing blocklist, so I cannot tell you whether this server is ' +
      'protected right now. Link checking may still be running. This is a Proton-side problem, ' +
      'not a setting in this server.'
    );
  }

  const lines: string[] = [];

  if (stats.size === 0) {
    lines.push(
      '**No blocklist is loaded, so no links are being checked.** Every feed failed, or the ' +
        'cached list expired before a refresh succeeded. This is a Proton-side problem, not ' +
        'a setting in this server.',
    );
  } else {
    lines.push(`**${stats.size.toLocaleString('en')} domains** are being checked against.`);
  }

  if (stats.refreshedAt === null) {
    lines.push('The list has never been refreshed since this Proton instance started.');
  } else {
    const age = Date.now() - stats.refreshedAt.getTime();
    lines.push(
      `Last refreshed ${formatDuration(Math.max(age, 1000))} ago from ` +
        `${stats.feeds.length} feed(s).`,
    );
  }

  for (const failure of stats.failures) {
    lines.push(`Feed failed: \`${failure.url}\` — ${failure.reason}`);
  }

  if (!config.enabled) {
    lines.push('Detection is switched **off** for this server in the Proton dashboard.');
  } else {
    lines.push(
      `On a match: **${config.action}**${
        config.action === 'timeout' ? ` (${config.timeoutDuration})` : ''
      }. ` +
        `${config.blockDomains.length} extra blocked domain(s), ` +
        `${config.allowDomains.length} never blocked.`,
    );
  }

  return lines.join('\n');
}
