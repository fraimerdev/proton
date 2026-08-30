import type { Logger } from '../modules/manifest.ts';
import type { CaseRecorder } from './case-recorder.ts';
import type { DedupeStore } from './dedupe.ts';
import { type ActionKind, isNeverRecorded, reversalOf } from './kinds.ts';
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

  // Where the technical half of a failure goes. What the caller gets back is written for whoever
  // typed the command, so the status code and Discord's own wording survive only if this is bound.
  logger?: Logger;
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
        "I couldn't carry that out, and nothing was changed. This is a Proton problem, not a " +
          'setting in this server.',
        `invalid action request: ${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
          .join('; ')}`,
        request,
      );
    }

    if (request.expiresAt && !this.#deps.scheduleReversal) {
      return this.#precheckFailure(
        'unsupported_expiry',
        "I can't set that to lift on its own — Proton can't schedule the reversal here. " +
          'Nothing was changed.',
        'the request carried an expiry but no reversal scheduler is bound',
        request,
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
        const said = discordMessage(response.body);
        this.#log(request, `Discord answered ${response.status}${said ? `: ${said}` : ''}`);

        return {
          status: 'failed_api',
          failure: {
            code: `discord_${response.status}`,
            humanReason: describeDiscordError(response.status),
          },
        };
      }

      const { caseId } = await this.#record(request);

      if (request.expiresAt && caseId) {
        try {
          await this.#deps.scheduleReversal?.(request, caseId);
        } catch (error) {
          this.#log(request, `the reversal could not be scheduled: ${detailOf(error)}`);
          return {
            caseId,
            status: 'executed',
            failure: {
              code: 'reversal_not_scheduled',
              humanReason:
                `${appliedPhrase(request.kind)}, but I couldn't schedule it to lift on its own. ` +
                'It will stay in place until somebody reverses it.',
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
      this.#log(request, `could not reach Discord: ${detailOf(error)}`);

      return {
        status: 'failed_api',
        failure: {
          code: 'transport_failure',
          humanReason:
            "I couldn't reach Discord. That may not have gone through — check before trying again.",
        },
      };
    }
  }

  #precheckFailure(
    code: string,
    humanReason: string,
    detail?: string,
    request?: ActionRequest,
  ): ActionResult {
    if (detail && request) this.#log(request, detail);

    return { status: 'failed_precheck', failure: { code, humanReason } };
  }

  #log(request: ActionRequest, detail: string): void {
    this.#deps.logger?.warn(`${request.kind} failed: ${detail}`, {
      guildId: request.guildId,
      moduleId: request.moduleId,
      kind: request.kind,
    });
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

function discordMessage(body: unknown): string | undefined {
  return typeof body === 'object' && body !== null && 'message' in body
    ? String((body as { message: unknown }).message)
    : undefined;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const APPLIED: Partial<Record<ActionKind, string>> = {
  ban: 'The ban went through',
  timeout: 'The timeout went through',
  add_role: 'The role was added',
  lockdown: 'The channel was locked',
};

function appliedPhrase(kind: ActionKind): string {
  return APPLIED[kind] ?? 'That went through';
}

function describeDiscordError(status: number): string {
  if (status === 403) {
    return (
      "Discord wouldn't let me do that. It is normally a permission I'm missing, or a role " +
      'ranked above mine.'
    );
  }
  if (status === 404) {
    return (
      "I couldn't find what that was meant to act on. It may have been deleted, or the member " +
      'may have left.'
    );
  }
  if (status === 429) {
    return "Discord is rate-limiting Proton right now. I'll retry this on my own.";
  }
  if (status >= 500) {
    return 'Discord is having trouble right now, so that may not have gone through.';
  }

  return (
    'Discord refused that, and nothing was changed. This is a Proton problem, not a setting in ' +
    'this server.'
  );
}
