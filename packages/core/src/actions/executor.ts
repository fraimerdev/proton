import type { z } from 'zod';
import type { CaseRecorder } from './case-recorder.ts';
import type { DedupeStore } from './dedupe.ts';
import { type PrecheckInput, runPrechecks } from './prechecks.ts';
import type { RestProxyClient } from './rest-client.ts';
import {
  type ActionExecutor,
  type ActionFailure,
  type ActionRequest,
  type ActionResult,
  actionRequestSchema,
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  interactionReplyPayloadSchema,
  MESSAGE_FLAG_EPHEMERAL,
  sendPayloadSchema,
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
}

/**
 * PLAN.md P3. Every state-changing Discord operation goes through here (I1).
 *
 * Pipeline, in the order §4-P3 mandates:
 *   validate → precheck (I8) → dedupe (I4) → execute via REST proxy → record
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
   * its `app_permissions` and resolved members.
   *
   * Modules receive the scoped executor and never see `hints`, so a module author
   * cannot forget to pass them and silently degrade the prechecks. The hints are
   * `unknown` here because what they contain is the concern of whichever
   * `resolveContext` the host wired in.
   */
  scoped(hints: unknown): ActionExecutor {
    return new DefaultActionExecutor(this.#deps, hints);
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    const parsed = actionRequestSchema.safeParse(request);
    if (!parsed.success) {
      return {
        status: 'failed_precheck',
        failure: {
          code: 'invalid_request',
          humanReason: `Invalid action request: ${parsed.error.issues
            .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
            .join('; ')}`,
        },
      };
    }

    if (request.expiresAt) {
      // Gate 0 ships no reversal scheduler. Accepting this would create a temp
      // action that silently never reverses — worse than refusing it.
      return {
        status: 'failed_precheck',
        failure: {
          code: 'unsupported_expiry',
          humanReason: 'Temporary actions are not available yet — no reversal scheduler exists.',
        },
      };
    }

    const payload = parsePayload(request);
    if ('error' in payload) {
      return {
        status: 'failed_precheck',
        failure: { code: 'invalid_payload', humanReason: payload.error },
      };
    }

    const resolved = await this.#deps.resolveContext(request, this.#hints);
    if ('failure' in resolved) {
      return { status: 'failed_precheck', failure: resolved.failure };
    }

    const failure = runPrechecks(resolved);
    if (failure) {
      return { status: 'failed_precheck', failure };
    }

    const claimed = await this.#deps.dedupe.claim(request.idempotencyKey, this.#ttl);
    if (!claimed) {
      return { status: 'skipped_duplicate' };
    }

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

interface RestCall {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * Validate the payload for a kind and derive the REST call it maps to.
 *
 * Kept together so adding an action kind is one exhaustive `switch` the compiler
 * checks, rather than a schema in one place and an endpoint in another that can
 * drift apart.
 */
function parsePayload(request: ActionRequest): { call: RestCall } | { error: string } {
  const fail = (issues: z.core.$ZodIssue[]): { error: string } => ({
    error: `Invalid payload for '${request.kind}': ${issues
      .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
      .join('; ')}`,
  });

  switch (request.kind) {
    case 'send': {
      const parsed = sendPayloadSchema.safeParse(request.payload);
      if (!parsed.success) return fail(parsed.error.issues);
      return {
        call: {
          method: 'POST',
          path: `/channels/${parsed.data.channelId}/messages`,
          body: { content: parsed.data.content },
        },
      };
    }

    case 'interaction_reply': {
      const parsed = interactionReplyPayloadSchema.safeParse(request.payload);
      if (!parsed.success) return fail(parsed.error.issues);
      return {
        call: {
          method: 'POST',
          path: `/interactions/${parsed.data.interactionId}/${parsed.data.interactionToken}/callback`,
          body: {
            type: INTERACTION_CALLBACK_CHANNEL_MESSAGE,
            data: {
              content: parsed.data.content,
              ...(parsed.data.ephemeral ? { flags: MESSAGE_FLAG_EPHEMERAL } : {}),
            },
          },
        },
      };
    }
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
    return `Discord couldn't find the target (404)${message ? `: ${message}` : ''}. It may have been deleted.`;
  }
  return `Discord returned ${status}${message ? `: ${message}` : ''}.`;
}
