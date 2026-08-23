import type { CaseRecorder } from './case-recorder.ts';
import type { DedupeStore } from './dedupe.ts';
import { isNeverRecorded, reversalOf } from './kinds.ts';
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

  resolveContext(
    request: ActionRequest,
    hints?: unknown,
  ): Promise<PrecheckInput | { failure: ActionFailure }>;

  dedupeTtlMs?: number;

  scheduleReversal?(request: ActionRequest, caseId: string): Promise<void>;
}

export class DefaultActionExecutor implements ActionExecutor {
  readonly #deps: ActionExecutorDeps;
  readonly #ttl: number;
  readonly #hints: unknown;

  constructor(deps: ActionExecutorDeps, hints?: unknown) {
    this.#deps = deps;
    this.#ttl = deps.dedupeTtlMs ?? 24 * 60 * 60 * 1000;
    this.#hints = hints;
  }

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

    if (request.expiresAt && !reversalOf(request.kind)) {
      return this.#precheckFailure(
        'not_reversible',
        `A '${request.kind}' can't be temporary — Proton has no action that undoes it. ` +
          'Perform it without a duration, or pick an action that can be reversed.',
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
        const { caseId } = await this.#record(request);
        return { ...(caseId ? { caseId } : {}), status: 'dry_run' };
      }

      if ('ledgerOnly' in payload) {
        const { caseId } = await this.#record(request);
        return { ...(caseId ? { caseId } : {}), status: 'executed' };
      }

      const response = await this.#deps.rest.request(payload.call);

      if (response.status >= 400) {
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

      if (request.expiresAt && caseId) {
        try {
          await this.#deps.scheduleReversal?.(request, caseId);
        } catch (error) {
          return {
            caseId,
            status: 'executed',
            failure: {
              code: 'reversal_not_scheduled',
              humanReason:
                `The ${request.kind} was applied, but I couldn't schedule its automatic ` +
                `reversal (${error instanceof Error ? error.message : String(error)}). ` +
                'It will not lift on its own — reverse it manually.',
            },
          };
        }
      }

      return {
        ...(caseId ? { caseId } : {}),
        status: 'executed',
        ...(response.body !== undefined ? { body: response.body } : {}),
      };
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

  async #record(request: ActionRequest): Promise<{ caseId?: string }> {
    // Ahead of request.record: no call site may opt an interaction acknowledgement into the ledger.
    if (isNeverRecorded(request.kind) || request.record === false) return {};

    return this.#deps.recorder.record({
      guildId: request.guildId,
      moduleId: request.moduleId,
      kind: request.kind,
      actorId: request.actorId,
      targetId: request.targetId,
      reason: request.reason,
      payload: redactSecrets(request.payload),

      expiresAt: request.expiresAt,
      dryRun: request.dryRun,
      idempotencyKey: request.idempotencyKey,
    });
  }
}

export const REDACTED = '[redacted]';

const CREDENTIAL_KEY = /token|secret|password|credential|authorization/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isPlainObject(value)) return value;

  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    clean[key] = CREDENTIAL_KEY.test(key) ? REDACTED : redactSecrets(entry);
  }

  return clean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  // Plain objects only: walking an attachment's Uint8Array would rewrite it as index keys.
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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
