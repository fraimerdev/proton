import { type CommandDefinition, formatDuration, Permissions } from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType } from 'discord-api-types/v10';
import type { PhishingConfig } from './config.ts';
import { bindDeps, describeUnbound, type PhishingDeps } from './deps.ts';
import { MODULE_ID } from './listener.ts';
import type { BlocklistStats } from './store.ts';

/**
 * `/phishing` — how many domains are loaded, from where, and when.
 *
 * The only feature in Gate 2 that depends on something outside Proton is this
 * one, which means it is the only one that can be quietly doing nothing while
 * every dashboard toggle says it is on. A blocklist of zero domains looks
 * identical, from inside a server, to a week in which nobody posted a scam. This
 * command is what makes those two distinguishable without shell access to the
 * worker's logs, and it is the reason the store exposes `stats()` at all.
 */
export function createPhishingStatusCommand(deps: PhishingDeps): CommandDefinition<PhishingConfig> {
  return {
    name: 'phishing',
    description: 'Show the state of the phishing blocklist in this server.',

    data: new SlashCommandBuilder()
      .setName('phishing')
      .setDescription('Show the state of the phishing blocklist in this server.')
      .setContexts(InteractionContextType.Guild)
      // Whoever can configure the module can inspect it. Not ModerateMembers:
      // the answer is about Proton's health, not about a member.
      .setDefaultMemberPermissions(Permissions.ManageGuild)
      .toJSON(),

    async handler(ctx) {
      const bound = bindDeps(deps);

      const body =
        'unbound' in bound
          ? describeUnbound(bound.unbound)
          : await describeStats(bound.deps.blocklist.stats(), ctx.config);

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
          // Server health, not an announcement.
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
): Promise<string> {
  let stats: BlocklistStats;
  try {
    stats = await pending;
  } catch (error) {
    return (
      'I could not read the phishing blocklist cache, so I do not know whether this server ' +
      `is protected: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const lines: string[] = [];

  if (stats.size === 0) {
    // Stated first and stated plainly. Everything else on this reply is detail
    // about a module that is currently catching nothing.
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
