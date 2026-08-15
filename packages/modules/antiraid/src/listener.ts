import {
  dryRunFor,
  type EventListener,
  type EventType,
  type ModuleContext,
  type ProtonEvent,
  RATE_WINDOW_GUILD_SCOPE,
  type RateWindowStore,
} from '@proton/core';
import { type AntiraidConfig, readScoreSettings } from './config.ts';
import { readJoin } from './join.ts';
import { planResponse, RESPONSE_LABELS, responseKind, responseUnconfigured } from './response.ts';
import { MAX_JOIN_SCORE, scoreJoin } from './score.ts';

export const ANTIRAID_MODULE_ID = 'antiraid';

/**
 * `ActionRequest.actorId` for anything anti-raid did.
 *
 * Not a snowflake, for the same reason as `RULE_ENGINE_ACTOR`: nobody pressed a
 * button. Attributing a quarantine to the admin who once enabled the module
 * would read in the case ledger as that person having done it by hand.
 */
export const ANTIRAID_ACTOR = 'proton:antiraid';

/**
 * The rule slot of the join-rate window.
 *
 * The window is keyed by `(guildId, ruleId, actorId)` and the rule engine
 * namespaces its own as `moduleId:ruleId`, so this follows the same shape and
 * cannot collide with a rule an admin writes.
 */
export const JOIN_RATE_RULE_ID = `${ANTIRAID_MODULE_ID}:join-rate`;

export const ANTIRAID_EVENT_TYPES: EventType[] = ['member.joined'];

export interface AntiraidDeps {
  /**
   * The sliding join-rate counter.
   *
   * `RedisRateWindow` from core, injected rather than constructed here: it is the
   * one atomic implementation (§4-P2), and a second one written inside this
   * module would drift from the anti-nuke windows that share it. Optional only
   * because §7's `ModuleContext` has no port to hand one through — the same gap
   * the logging module's store injection works around. A module built without
   * one still registers and still renders its config, and says loudly what is
   * missing the first time a guild that enabled it sees a join.
   */
  rateWindow?: RateWindowStore;
}

const UNBOUND_WINDOW =
  'Anti-raid is enabled for this guild but no join-rate window is bound, so joins are not ' +
  'being counted and no raid can be detected. The process running modules must construct ' +
  'RedisRateWindow(redis) and pass it to createAntiraidModule({ rateWindow }).';

/**
 * Tell the guild that raid mode has engaged.
 *
 * Sent once per crossing rather than once per flagged account: `tripped` is true
 * on exactly the join that took the window over the threshold, so a 200-account
 * raid produces one message instead of 200. The message names what Proton is
 * doing about it, because an alert that only says "raid detected" leaves staff
 * to guess whether they still have to act.
 */
async function announceRaid(
  ctx: ModuleContext<AntiraidConfig>,
  event: ProtonEvent,
  joinsInWindow: number,
): Promise<void> {
  const channelId = ctx.config.alertChannelId;
  if (!channelId) return;

  const kind = responseKind(ctx.config.response);
  const parts = [
    `**Raid mode.** ${joinsInWindow} accounts joined within ${ctx.config.joinWindow}, at or ` +
      `above this server's threshold of ${ctx.config.joinThreshold}.`,
    `Joins scoring ${ctx.config.scoreThreshold}/${MAX_JOIN_SCORE} or higher are ` +
      `${RESPONSE_LABELS[ctx.config.response]}.`,
  ];

  const unconfigured = responseUnconfigured(ctx.config);
  if (unconfigured) parts.push(unconfigured);

  if (dryRunFor(kind)) {
    // Otherwise the alert claims accounts are being removed while I12 is quietly
    // withholding every kick, which is the worst possible thing to be wrong about
    // in the middle of a raid.
    parts.push(
      `Nothing is actually being removed: Proton refuses destructive actions outside ` +
        `production (NODE_ENV is '${process.env.NODE_ENV ?? 'unset'}').`,
    );
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: ANTIRAID_MODULE_ID,
    kind: 'send',
    actorId: ANTIRAID_ACTOR,
    // Derived from the event that crossed the threshold, so a redelivered join
    // does not announce the same raid twice (I4).
    idempotencyKey: `antiraid:${event.id}:alert`,
    // Never dry-run: I12 withholds the destructive effect, not the warning.
    dryRun: false,
    payload: { channelId, content: parts.join(' ').slice(0, 2000) },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `anti-raid could not post the raid alert: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: ANTIRAID_MODULE_ID, channelId },
    );
  }
}

/**
 * Screen every join (PLAN.md §8 Phase 2: join-rate, account-age and avatarless
 * heuristics).
 *
 * Three signals, combined, because each one alone describes a great many real
 * members: servers get linked on Reddit and grow in bursts, new accounts join
 * servers on their first day, and plenty of people never set an avatar. The
 * combination is what carries information, and `MIN_ACTIONABLE_SCORE` makes "at
 * least two of them" a constraint the config cannot escape.
 */
export function createJoinListener(deps: AntiraidDeps): EventListener<AntiraidConfig> {
  return {
    types: ANTIRAID_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      const facts = readJoin(event);
      if (!facts) {
        ctx.logger.warn('a member.joined event carried no user id, so it was not screened', {
          guildId: ctx.guildId,
          moduleId: ANTIRAID_MODULE_ID,
          eventId: event.id,
        });
        return;
      }

      // A bot is added by someone holding MANAGE_GUILD, which makes a hostile one
      // anti-nuke's problem. Skipped before the window, so adding a bot mid-wave
      // does not nudge the join rate either.
      if (facts.isBot) return;

      if (!deps.rateWindow) {
        ctx.logger.error(UNBOUND_WINDOW, { guildId: ctx.guildId, moduleId: ANTIRAID_MODULE_ID });
        return;
      }

      const parsed = readScoreSettings(ctx.config);
      if ('invalid' in parsed) {
        ctx.logger.error(parsed.invalid, { guildId: ctx.guildId, moduleId: ANTIRAID_MODULE_ID });
        return;
      }

      // The event's own time, never the clock. `occurredAt` on a join is
      // Discord's `joined_at`, so a redelivery or a fixture replay lands in the
      // window slot it originally occupied, and a bus backlog cannot compress a
      // wave that really was spread out (§15: key on actor and time, never on
      // delivery order).
      const now = event.occurredAt;

      const { count, tripped } = await deps.rateWindow.hit({
        guildId: ctx.guildId,
        ruleId: JOIN_RATE_RULE_ID,
        // One window for the whole guild. A raid is a hundred accounts joining
        // once each, so a per-actor window would count to one, a hundred times.
        actorId: RATE_WINDOW_GUILD_SCOPE,
        windowMs: parsed.joinWindowMs,
        limit: ctx.config.joinThreshold,
        // The event id, so a RESUME redelivery lands on the sorted-set member it
        // already occupies and is not counted twice (I4).
        member: event.id,
        now,
      });

      const score = scoreJoin(
        {
          joinsInWindow: count,
          accountAgeMs:
            facts.accountCreatedAt === null ? null : Math.max(0, now - facts.accountCreatedAt),
          avatarless: facts.avatarless,
        },
        parsed.settings,
      );

      if (tripped) await announceRaid(ctx, event, count);

      if (score.score < ctx.config.scoreThreshold) {
        if (score.burst) {
          // Worth a line: these are the accounts that joined during a raid and
          // were deliberately let through, which is the first thing anyone asks
          // about afterwards.
          ctx.logger.info('join scored below the threshold during a burst and was let through', {
            guildId: ctx.guildId,
            moduleId: ANTIRAID_MODULE_ID,
            userId: facts.userId,
            score: score.score,
            threshold: ctx.config.scoreThreshold,
          });
        }
        return;
      }

      const planned = planResponse(ctx.config, facts.userId, score);
      if ('unconfigured' in planned) {
        ctx.logger.error(planned.unconfigured, {
          guildId: ctx.guildId,
          moduleId: ANTIRAID_MODULE_ID,
          userId: facts.userId,
        });
        return;
      }

      const { plan } = planned;
      const result = await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: ANTIRAID_MODULE_ID,
        kind: plan.kind,
        targetId: facts.userId,
        actorId: ANTIRAID_ACTOR,
        reason: plan.reason,
        payload: plan.payload,
        dryRun: dryRunFor(plan.kind),
        // Derived from the event id, so however many times the join is delivered
        // the member is acted on once (I4).
        idempotencyKey: `antiraid:${event.id}:response`,
      });

      if (result.status === 'failed_precheck' || result.status === 'failed_api') {
        // Verbatim: the executor already knows which permission is missing and
        // where (I8), and paraphrasing it here would throw that away.
        ctx.logger.warn(
          `anti-raid could not ${plan.kind} ${facts.userId}: ${
            result.failure?.humanReason ?? 'no reason was reported'
          }`,
          {
            guildId: ctx.guildId,
            moduleId: ANTIRAID_MODULE_ID,
            userId: facts.userId,
            code: result.failure?.code,
          },
        );
        return;
      }

      ctx.logger.info(`anti-raid ${plan.kind}: ${result.status}`, {
        guildId: ctx.guildId,
        moduleId: ANTIRAID_MODULE_ID,
        userId: facts.userId,
        score: score.score,
        response: ctx.config.response,
        caseId: result.caseId,
      });
    },
  };
}
