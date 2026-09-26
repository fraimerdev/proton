import type { Logger } from '../modules/manifest.ts';
import type { CaseRecorder } from './case-recorder.ts';
import type { DedupeStore } from './dedupe.ts';
import { describeDiscordError, refusalDetail } from './discord-error.ts';
import { type ActionKind, exposesUpstreamOnFailure, isNeverRecorded, reversalOf } from './kinds.ts';
import { type PrecheckInput, runPrechecks } from './prechecks.ts';
import type { RestProxyClient } from './rest-client.ts';
import { type PayloadResult, toRestCall } from './rest-mapping.ts';
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

  async precheck(request: ActionRequest): Promise<ActionFailure | null> {
    const checked = await this.#check(request);
    return 'result' in checked ? (checked.result.failure ?? null) : null;
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    const checked = await this.#check(request);
    if ('result' in checked) return checked.result;
    const { payload, resolved } = checked;

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
        this.#log(request, refusalDetail(response.status, response.body));
        const discordCode = discordErrorCode(response.body);

        return {
          status: 'failed_api',
          failure: {
            code: `discord_${response.status}`,
            humanReason: describeDiscordError({
              status: response.status,
              body: response.body,
              request,
              resolved,
            }),
            ...(discordCode !== undefined ? { discordCode } : {}),
          },
          ...(exposesUpstreamOnFailure(request.kind)
            ? { upstream: { status: response.status, body: response.body } }
            : {}),
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
                `${appliedPhrase(request.kind)}, but it couldn't be scheduled to lift on its own. ` +
                'It stays in place until somebody reverses it.',
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
            "Couldn't reach Discord, so that may not have gone through. Check before trying again.",
        },
      };
    }
  }

  async #check(
    request: ActionRequest,
  ): Promise<
    | { result: ActionResult }
    | { payload: Exclude<PayloadResult, { error: string }>; resolved: PrecheckInput }
  > {
    const parsed = actionRequestSchema.safeParse(request);
    if (!parsed.success) {
      return this.#precheckFailure(
        'invalid_request',
        "That couldn't be done, and nothing was changed. This is a Proton problem, not a " +
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
        "That can't be set to lift on its own here, so nothing was changed.",
        'the request carried an expiry but no reversal scheduler is bound',
        request,
      );
    }

    if (request.expiresAt && !reversalOf(request.kind)) {
      return this.#precheckFailure(
        'not_reversible',
        `A '${request.kind}' can't be temporary because nothing can undo it. Do it without a ` +
          'duration, or pick an action that can be undone.',
      );
    }

    const payload = toRestCall(request);
    if ('error' in payload) {
      return this.#precheckFailure('invalid_payload', payload.error);
    }

    // Ahead of the prechecks, not redundant with claim(): a kicked or banned member 404s the lookup.
    if (await this.#deps.dedupe.has(request.idempotencyKey)) {
      return { result: { status: 'skipped_duplicate' } };
    }

    const resolved = await this.#deps.resolveContext(request, this.#hints);
    if ('failure' in resolved) {
      return { result: { status: 'failed_precheck', failure: resolved.failure } };
    }

    const failure = runPrechecks(resolved);
    if (failure) return { result: { status: 'failed_precheck', failure } };

    return { payload, resolved };
  }

  #precheckFailure(
    code: string,
    humanReason: string,
    detail?: string,
    request?: ActionRequest,
  ): { result: ActionResult } {
    if (detail && request) this.#log(request, detail);

    return { result: { status: 'failed_precheck', failure: { code, humanReason } } };
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

function discordErrorCode(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null || !('code' in body)) return undefined;
  const code = (body as { code: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) ? code : undefined;
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
