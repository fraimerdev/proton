import type { DraftAnswers, RawAnswer } from '@proton/module-applications/questions';
import type { DraftSaveResult } from '@proton/module-applications/view';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { failureKind, saveFailure } from '../../lib/errors.ts';

export const AUTOSAVE_DELAY_MS = 1200;
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;

export type SavePhase = 'saved' | 'unsaved' | 'saving' | 'retrying' | 'conflict' | 'refused';

export interface ServerDraft {
  revision: number;
  answers: DraftAnswers;
  updatedAt: number;
}

export interface DraftState {
  revision: number | null;
  saved: DraftAnswers;
  answers: DraftAnswers;
  phase: SavePhase;
  savedAt: number | null;
  newer: ServerDraft | null;
  refusal: string | null;
  retryable: boolean;
  failures: number;
}

export interface SaveRequest {
  answers: DraftAnswers;
  expectedRevision: number | null;
}

export type SaveOutcome =
  | DraftSaveResult
  | { status: 'failed'; message: string }
  | { status: 'blocked'; message: string };

const NOT_SAVED = 'Your latest answers weren’t saved';

const ANSWERS_REFUSED = `${NOT_SAVED}. One of them doesn’t fit this form. Check your answers, then try again.`;

function isRefusedInput(error: Error): boolean {
  return error.name === 'ZodError' || /^\s*\[\s*\{[\s\S]*"code"\s*:/.test(error.message);
}

export function thrownOutcome(thrown: unknown): SaveOutcome {
  const error = thrown instanceof Error ? thrown : new Error(String(thrown));
  if (isRefusedInput(error)) return { status: 'blocked', message: ANSWERS_REFUSED };

  const kind = failureKind(error);
  if (kind === 'unreachable' || kind === 'unknown') {
    return { status: 'failed', message: error.message };
  }

  return { status: 'blocked', message: saveFailure(error, NOT_SAVED) };
}

export function refreshesForm(outcome: SaveOutcome): boolean {
  return outcome.status === 'refused' || outcome.status === 'conflict';
}

export function problemsOffPage(
  problems: readonly { questionId: string }[],
  shown: ReadonlySet<string>,
): boolean {
  return problems.some((problem) => !shown.has(problem.questionId));
}

export function newRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isEmpty(value: RawAnswer | undefined): boolean {
  if (value === undefined || value === false) return true;
  if (typeof value === 'string') return value === '';
  return Array.isArray(value) && value.length === 0;
}

export function cleanAnswers(answers: DraftAnswers): DraftAnswers {
  const clean: DraftAnswers = {};
  for (const [id, value] of Object.entries(answers)) {
    if (!isEmpty(value)) clean[id] = value;
  }
  return clean;
}

function stable(answers: DraftAnswers): string {
  const clean = cleanAnswers(answers);
  return JSON.stringify(
    Object.keys(clean)
      .sort()
      .map((id) => [id, clean[id]]),
  );
}

export function sameAnswers(a: DraftAnswers, b: DraftAnswers): boolean {
  return stable(a) === stable(b);
}

export function openDraft(draft: ServerDraft | null): DraftState {
  return {
    revision: draft?.revision ?? null,
    saved: draft?.answers ?? {},
    answers: draft?.answers ?? {},
    phase: 'saved',
    savedAt: draft?.updatedAt ?? null,
    newer: null,
    refusal: null,
    retryable: false,
    failures: 0,
  };
}

function settled(phase: SavePhase): boolean {
  return phase === 'saved' || phase === 'unsaved';
}

export function edited(
  state: DraftState,
  answers: DraftAnswers,
  outgoing: DraftAnswers,
): DraftState {
  if (!settled(state.phase)) return { ...state, answers };
  return { ...state, answers, phase: sameAnswers(outgoing, state.saved) ? 'saved' : 'unsaved' };
}

export function startSave(
  state: DraftState,
  outgoing: DraftAnswers,
): { state: DraftState; request: SaveRequest | null } {
  if (state.phase === 'saving' || state.phase === 'conflict' || state.phase === 'refused') {
    return { state, request: null };
  }

  if (sameAnswers(outgoing, state.saved)) {
    return { state: { ...state, phase: 'saved', failures: 0 }, request: null };
  }

  return {
    state: { ...state, phase: 'saving' },
    request: { answers: cleanAnswers(outgoing), expectedRevision: state.revision },
  };
}

export function finishSave(
  state: DraftState,
  request: SaveRequest,
  outcome: SaveOutcome,
  outgoing: DraftAnswers,
): DraftState {
  switch (outcome.status) {
    case 'saved':
      return {
        ...state,
        revision: outcome.revision,
        saved: request.answers,
        savedAt: outcome.savedAt,
        phase: sameAnswers(outgoing, request.answers) ? 'saved' : 'unsaved',
        refusal: null,
        retryable: false,
        failures: 0,
      };

    case 'conflict':
      return { ...state, phase: 'conflict', newer: outcome.draft, failures: 0 };

    case 'refused':
      return {
        ...state,
        phase: 'refused',
        refusal: outcome.message,
        retryable: false,
        failures: 0,
      };

    case 'blocked':
      return { ...state, phase: 'refused', refusal: outcome.message, retryable: true, failures: 0 };

    case 'failed':
      return { ...state, phase: 'retrying', failures: state.failures + 1 };
  }
}

export function acceptNewer(state: DraftState): DraftState {
  if (state.newer === null) return state;

  return {
    ...state,
    revision: state.newer.revision,
    saved: state.newer.answers,
    answers: state.newer.answers,
    savedAt: state.newer.updatedAt,
    newer: null,
    phase: 'saved',
  };
}

export function keepMine(state: DraftState): DraftState {
  if (state.newer === null) return state;

  // Saved is the newer revision's answers, so the next save sees the page differ and overwrites it.
  return {
    ...state,
    revision: state.newer.revision,
    saved: state.newer.answers,
    newer: null,
    phase: 'unsaved',
  };
}

export function retryRefused(state: DraftState): DraftState {
  if (state.phase !== 'refused') return state;
  return { ...state, phase: 'unsaved', refusal: null, retryable: false };
}

export function startOver(state: DraftState): DraftState {
  return {
    ...state,
    revision: null,
    saved: {},
    newer: null,
    refusal: null,
    retryable: false,
    failures: 0,
    phase: 'unsaved',
  };
}

export function conflictWith(
  state: DraftState,
  draft: ServerDraft,
  outgoing: DraftAnswers,
): DraftState {
  if (sameAnswers(draft.answers, outgoing)) {
    return {
      ...state,
      revision: draft.revision,
      saved: draft.answers,
      savedAt: draft.updatedAt,
      newer: null,
      refusal: null,
      retryable: false,
      phase: 'saved',
    };
  }

  return { ...state, phase: 'conflict', newer: draft };
}

export function adoptServer(
  state: DraftState,
  draft: ServerDraft | null,
  outgoing: DraftAnswers,
): DraftState {
  if (draft === null) return state;
  if (state.revision !== null && draft.revision <= state.revision) return state;
  if (state.phase === 'saving' || state.phase === 'retrying' || state.phase === 'refused') {
    return state;
  }

  if (sameAnswers(draft.answers, outgoing)) {
    return {
      ...state,
      revision: draft.revision,
      saved: draft.answers,
      savedAt: draft.updatedAt,
      newer: null,
      phase: 'saved',
    };
  }

  if (state.phase === 'saved') {
    return {
      ...state,
      revision: draft.revision,
      saved: draft.answers,
      answers: draft.answers,
      savedAt: draft.updatedAt,
      newer: null,
    };
  }

  return { ...state, phase: 'conflict', newer: draft };
}

export function retryDelay(failures: number): number {
  const at = Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[at] ?? 30_000;
}

export function hasUnsaved(state: DraftState, outgoing: DraftAnswers): boolean {
  if (state.phase === 'saving' || state.phase === 'retrying' || state.phase === 'conflict') {
    return true;
  }
  return !sameAnswers(outgoing, state.saved);
}

export type SaveIndicator =
  | { phase: 'idle' }
  | { phase: 'working' | 'completed' | 'failed'; label: string };

export function saveIndicator(state: DraftState): SaveIndicator {
  switch (state.phase) {
    case 'saving':
      return { phase: 'working', label: 'Saving…' };
    case 'saved':
      return state.savedAt === null ? { phase: 'idle' } : { phase: 'completed', label: 'Saved' };
    case 'retrying':
      return { phase: 'failed', label: 'Couldn’t save. Retrying…' };
    case 'refused':
      return { phase: 'failed', label: 'Not saved' };
    default:
      return { phase: 'idle' };
  }
}

export interface Timers {
  set(run: () => void, ms: number): number;
  clear(handle: number): void;
}

const WINDOW_TIMERS: Timers = {
  set: (run, ms) => window.setTimeout(run, ms),
  clear: (handle) => window.clearTimeout(handle),
};

export class SaveTimer {
  readonly #timers: Timers;
  #handle: number | null = null;

  constructor(timers: Timers) {
    this.#timers = timers;
  }

  get pending(): boolean {
    return this.#handle !== null;
  }

  schedule(run: () => void, ms: number): void {
    this.cancel();
    this.#handle = this.#timers.set(() => {
      this.#handle = null;
      run();
    }, ms);
  }

  cancel(): void {
    if (this.#handle === null) return;
    this.#timers.clear(this.#handle);
    this.#handle = null;
  }
}

export interface DraftAutosaveActions {
  setAnswers(update: (current: DraftAnswers) => DraftAnswers): void;
  commit(): void;
  flush(): Promise<DraftState>;
  takeNewer(): void;
  keepMine(): void;
  retry(): void;
  startOver(): void;
  conflict(draft: ServerDraft): void;
  adopt(draft: ServerDraft | null): void;
  reset(draft: ServerDraft | null): void;
}

export interface DraftAutosave {
  state: DraftState;
  actions: DraftAutosaveActions;
}

export function useDraftAutosave(options: {
  initial: ServerDraft | null;
  outgoing(answers: DraftAnswers): DraftAnswers;
  save(request: SaveRequest & { requestId: string }): Promise<SaveOutcome>;
  timers?: Timers | undefined;
}): DraftAutosave {
  const [state, setState] = useState(() => openDraft(options.initial));
  const current = useRef(state);
  const latest = useRef(options);
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<SaveTimer | null>(null);

  latest.current = options;
  timer.current ??= new SaveTimer(options.timers ?? WINDOW_TIMERS);

  const apply = useCallback((next: DraftState): void => {
    current.current = next;
    setState(next);
  }, []);

  const outgoingOf = useCallback(
    (answers: DraftAnswers): DraftAnswers => latest.current.outgoing(answers),
    [],
  );

  const run = useCallback(async (): Promise<void> => {
    while (inFlight.current !== null) await inFlight.current;

    const started = startSave(current.current, outgoingOf(current.current.answers));
    if (started.state !== current.current) apply(started.state);
    const { request } = started;
    if (request === null) return;

    const work = (async (): Promise<void> => {
      let outcome: SaveOutcome;
      try {
        outcome = await latest.current.save({ ...request, requestId: newRequestId() });
      } catch (error) {
        outcome = thrownOutcome(error);
      }

      const next = finishSave(
        current.current,
        request,
        outcome,
        outgoingOf(current.current.answers),
      );
      apply(next);

      if (next.phase === 'retrying') {
        timer.current?.schedule(() => void run(), retryDelay(next.failures));
      } else if (next.phase === 'unsaved') {
        timer.current?.schedule(() => void run(), AUTOSAVE_DELAY_MS);
      }
    })();

    inFlight.current = work;
    try {
      await work;
    } finally {
      inFlight.current = null;
    }
  }, [apply, outgoingOf]);

  useEffect(() => () => timer.current?.cancel(), []);

  const actions = useMemo<DraftAutosaveActions>(() => {
    const saveNow = (next: DraftState): void => {
      apply(next);
      timer.current?.cancel();
      void run();
    };

    return {
      setAnswers: (update) => {
        const answers = update(current.current.answers);
        const next = edited(current.current, answers, outgoingOf(answers));
        apply(next);
        if (next.phase === 'unsaved') {
          timer.current?.schedule(() => void run(), AUTOSAVE_DELAY_MS);
        }
      },

      commit: () => {
        const { phase } = current.current;
        if (phase !== 'unsaved' && phase !== 'retrying') return;
        timer.current?.cancel();
        void run();
      },

      flush: async () => {
        timer.current?.cancel();
        await run();
        return current.current;
      },

      takeNewer: () => apply(acceptNewer(current.current)),
      keepMine: () => saveNow(keepMine(current.current)),
      retry: () => saveNow(retryRefused(current.current)),
      startOver: () => saveNow(startOver(current.current)),

      conflict: (draft) =>
        apply(conflictWith(current.current, draft, outgoingOf(current.current.answers))),

      adopt: (draft) =>
        apply(adoptServer(current.current, draft, outgoingOf(current.current.answers))),

      reset: (draft) => {
        timer.current?.cancel();
        apply(openDraft(draft));
      },
    };
  }, [apply, outgoingOf, run]);

  return { state, actions };
}
