import type { CaseRecorder } from './case-recorder.ts';
import type { DedupeStore } from './dedupe.ts';
import { type PrecheckInput, runPrechecks } from './prechecks.ts';
import type { RestProxyClient } from './rest-client.ts';
import { toRestCall } from './rest-mapping.ts';
import {
  type ActionExecutor,
  type ActionFailure,
  type ActionRequest,
  type ActionResult,
  actionRequestSchema,
} from './types.ts';

export interface ActionExecutorDeps {
  dedupe: DedupeStore;
  rest: RestProxyClient;
  recorder: CaseRecorder;
  /**
   * Fetch the guild/bot/channel state the prechecks need. Injected so the
   * executor performs no lookups of its own and stays testable without Discord.
   *
   * May return `{ failure }` to mean "I could not establish whether this is
   * safe". That is a precheck failure, not an error — the alternative is
   * inventing permissive defaults, which is precisely how the Gate 0 stub
   * disabled the owner and hierarchy checks.
   */
  resolveContext(
    request: ActionRequest,
    hints?: unknown,
  ): Promise<PrecheckInput | { failure: ActionFailure }>;
  /** How long an idempotency claim is held. Should exceed the retry window. */
  dedupeTtlMs?: number;
  /**
   * Schedule the reversal of a temporary action. Absent until P1.C, and while
   * it is absent a request carrying `expiresAt` is refused rather than executed
   * — a temp ban that never lifts is worse than one that never happens.
   */
  scheduleReversal?(request: ActionRequest, caseId: string): Promise<void>;
}

/**
 * PLAN.md P3. Every state-changing Discord operation goes through here (I1).
 *
 * Pipeline, in the order §4-P3 mandates:
 *   validate → precheck (I8) → dedupe (I4) → execute via REST proxy → record
 *   → schedule reversal if `expiresAt`
 *
 * Dedupe deliberately comes *after* prechecks: claiming the key first would mean
 * a request that failed its prechecks had already burned its idempotency key, so
 * the corrected retry would be discarded as a duplicate.
 */
export class DefaultActionExecutor implements ActionExecutor {
  readonly #deps: ActionExecutorDeps;
  readonly #ttl: number;
  readonly #hints: unknown;

  constructor(deps: ActionExecutorDeps, hints?: unknown) {
    this.#deps = deps;
    this.#ttl = deps.dedupeTtlMs ?? 24 * 60 * 60 * 1000;
    this.#hints = hints;
  }

  /**
   * A view of this executor bound to per-invocation context — for an interaction,
   * its `app_permissions`.
   *
   * Modules receive the scoped executor and never see `hints`, so a module author
   * cannot forget to pass them and silently degrade the prechecks.
   */
  scoped(hints: unknown): ActionExecutor {
    return new DefaultActionExecutor(this.#deps, hints);
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    const parsed = actionRequestSchema.safeParse(request);
    if (!parsed.success) {
      return this.#precheckFailure(
        'invalid_request',
        `Invalid action request: ${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }

    if (request.expiresAt && !this.#deps.scheduleReversal) {
      return this.#precheckFailure(
        'unsupported_expiry',
        'Temporary actions are not available yet — no reversal scheduler is configured.',
      );
    }

    const payload = toRestCall(request);
    if ('error' in payload) {
      return this.#precheckFailure('invalid_payload', payload.error);
    }

    const resolved = await this.#deps.resolveContext(request, this.#hints);
    if ('failure' in resolved) {
      return { status: 'failed_precheck', failure: resolved.failure };
    }

    const failure = runPrechecks(resolved);
    if (failure) return { status: 'failed_precheck', failure };

    const claimed = await this.#deps.dedupe.claim(request.idempotencyKey, this.#ttl);
    if (!claimed) return { status: 'skipped_duplicate' };

    try {
      if (request.dryRun) {
        // I12: record what *would* have happened, issue no REST call at all.
        const { caseId } = await this.#record(request);
        return { caseId, status: 'dry_run' };
      }

      const response = await this.#deps.rest.request(payload.call);

      if (response.status >= 400) {
        // Give the key back so a retry is possible — a transient 500 must not
        // permanently poison this action.
        await this.#deps.dedupe.release(request.idempotencyKey);
        return {
          status: 'failed_api',
          failure: {
            code: `discord_${response.status}`,
            humanReason: describeDiscordError(response.status, response.body),
          },
        };
      }

      const { caseId } = await this.#record(request);

      if (request.expiresAt) {
        await this.#deps.scheduleReversal?.(request, caseId);
      }

      return { caseId, status: 'executed' };
    } catch (error) {
      await this.#deps.dedupe.release(request.idempotencyKey);
      return {
        status: 'failed_api',
        failure: {
          code: 'transport_failure',
          humanReason: `Couldn't reach Discord: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      };
    }
  }

  #precheckFailure(code: string, humanReason: string): ActionResult {
    return { status: 'failed_precheck', failure: { code, humanReason } };
  }

  async #record(request: ActionRequest): Promise<{ caseId: string }> {
    return this.#deps.recorder.record({
      guildId: request.guildId,
      moduleId: request.moduleId,
      kind: request.kind,
      actorId: request.actorId,
      targetId: request.targetId,
      reason: request.reason,
      payload: request.payload,
      dryRun: request.dryRun,
      idempotencyKey: request.idempotencyKey,
    });
  }
}

function describeDiscordError(status: number, body: unknown): string {
  const message =
    typeof body === 'object' && body !== null && 'message' in body
      ? String((body as { message: unknown }).message)
      : undefined;

  if (status === 403) {
    return `Discord refused the request (403 Forbidden)${message ? `: ${message}` : ''}. This is usually a missing permission or role hierarchy.`;
  }
  if (status === 404) {
    return `Discord couldn't find the target (404)${message ? `: ${message}` : ''}. It may have been deleted, or the member may have left.`;
  }
  if (status === 429) {
    return 'Discord rate-limited this action. It will be retried automatically.';
  }
  return `Discord returned ${status}${message ? `: ${message}` : ''}.`;
}
