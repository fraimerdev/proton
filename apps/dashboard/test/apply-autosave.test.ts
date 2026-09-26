import { describe, expect, test } from 'bun:test';
import type { DraftAnswers } from '@proton/module-applications/questions';
import { REQUEST_ID } from '@proton/module-applications/view';
import {
  AUTOSAVE_DELAY_MS,
  acceptNewer,
  adoptServer,
  cleanAnswers,
  conflictWith,
  type DraftState,
  edited,
  finishSave,
  hasUnsaved,
  keepMine,
  newRequestId,
  openDraft,
  problemsOffPage,
  RETRY_DELAYS_MS,
  refreshesForm,
  retryDelay,
  retryRefused,
  type SaveRequest,
  SaveTimer,
  sameAnswers,
  saveIndicator,
  startOver,
  startSave,
  type Timers,
  thrownOutcome,
} from '../src/pages/apply/autosave.ts';

class FakeClock implements Timers {
  now = 0;
  #next = 1;
  readonly #due = new Map<number, { at: number; run: () => void }>();

  set(run: () => void, ms: number): number {
    const handle = this.#next++;
    this.#due.set(handle, { at: this.now + ms, run });
    return handle;
  }

  clear(handle: number): void {
    this.#due.delete(handle);
  }

  advance(ms: number): void {
    const until = this.now + ms;

    for (;;) {
      let next: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.#due) {
        if (entry[1].at <= until && (next === undefined || entry[1].at < next[1].at)) next = entry;
      }
      if (next === undefined) break;

      this.#due.delete(next[0]);
      this.now = next[1].at;
      next[1].run();
    }

    this.now = until;
  }
}

const SAVED_AT = 1_790_000_000_000;

function saving(
  state: DraftState,
  outgoing: DraftAnswers,
): { state: DraftState; request: SaveRequest } {
  const started = startSave(state, outgoing);
  if (started.request === null) throw new Error('expected a save to start');
  return { state: started.state, request: started.request };
}

describe('comparing answers', () => {
  test('empty answers are the same as missing ones', () => {
    expect(cleanAnswers({ a: '', b: [], c: false, d: 'yes', e: true, f: ['x'] })).toEqual({
      d: 'yes',
      e: true,
      f: ['x'],
    });
    expect(sameAnswers({ a: 'x', b: '' }, { a: 'x' })).toBe(true);
  });

  test('key order does not matter, values do', () => {
    expect(sameAnswers({ a: 'x', b: 'y' }, { b: 'y', a: 'x' })).toBe(true);
    expect(sameAnswers({ a: 'x' }, { a: 'x ' })).toBe(false);
    expect(sameAnswers({ a: ['x', 'y'] }, { a: ['y', 'x'] })).toBe(false);
  });
});

describe('saving a draft', () => {
  test('a fresh form has nothing to save and says nothing', () => {
    const state = openDraft(null);

    expect(state.phase).toBe('saved');
    expect(startSave(state, {}).request).toBeNull();
    expect(saveIndicator(state)).toEqual({ phase: 'idle' });
    expect(hasUnsaved(state, {})).toBe(false);
  });

  test('the first save starts the draft, with no revision to check against', () => {
    const answers = { name: 'Ana', note: '' };
    const state = edited(openDraft(null), answers, answers);

    expect(state.phase).toBe('unsaved');
    expect(hasUnsaved(state, answers)).toBe(true);

    const { state: busy, request } = saving(state, answers);
    expect(busy.phase).toBe('saving');
    expect(request).toEqual({ answers: { name: 'Ana' }, expectedRevision: null });
    expect(saveIndicator(busy)).toEqual({ phase: 'working', label: 'Saving…' });

    const done = finishSave(
      busy,
      request,
      { status: 'saved', revision: 1, savedAt: SAVED_AT },
      answers,
    );
    expect(done).toMatchObject({ phase: 'saved', revision: 1, savedAt: SAVED_AT, failures: 0 });
    expect(saveIndicator(done)).toEqual({ phase: 'completed', label: 'Saved' });
    expect(hasUnsaved(done, answers)).toBe(false);
  });

  test('later saves send the revision they were based on', () => {
    const state = openDraft({ revision: 4, answers: { name: 'Ana' }, updatedAt: SAVED_AT });
    const answers = { name: 'Ana Silva' };

    const { request } = saving(edited(state, answers, answers), answers);
    expect(request.expectedRevision).toBe(4);
  });

  test('editing back to what was saved needs no save', () => {
    const state = openDraft({ revision: 2, answers: { name: 'Ana' }, updatedAt: SAVED_AT });
    const changed = edited(state, { name: 'An' }, { name: 'An' });
    const restored = edited(changed, { name: 'Ana' }, { name: 'Ana' });

    expect(changed.phase).toBe('unsaved');
    expect(restored.phase).toBe('saved');
  });

  test('hidden answers are kept on the page but never sent', () => {
    const local = { role: 'mod', portfolio: 'https://example.com' };
    const outgoing = { role: 'mod' };
    const state = edited(openDraft(null), local, outgoing);

    const { state: busy, request } = saving(state, outgoing);
    expect(request.answers).toEqual({ role: 'mod' });
    expect(busy.answers).toEqual(local);
  });

  test('typing during a save queues another one', () => {
    const first = { name: 'Ana' };
    const { state: busy, request } = saving(edited(openDraft(null), first, first), first);

    const typed = edited(busy, { name: 'Ana S' }, { name: 'Ana S' });
    expect(typed.phase).toBe('saving');
    expect(startSave(typed, { name: 'Ana S' }).request).toBeNull();

    const done = finishSave(
      typed,
      request,
      { status: 'saved', revision: 1, savedAt: SAVED_AT },
      { name: 'Ana S' },
    );
    expect(done.phase).toBe('unsaved');
    expect(done.saved).toEqual(first);
    expect(saving(done, { name: 'Ana S' }).request.expectedRevision).toBe(1);
  });
});

describe('when a save fails', () => {
  test('an outage retries, backing off', () => {
    const answers = { name: 'Ana' };
    const { state: busy, request } = saving(edited(openDraft(null), answers, answers), answers);

    const failed = finishSave(busy, request, { status: 'failed', message: 'down' }, answers);
    expect(failed).toMatchObject({ phase: 'retrying', failures: 1 });
    expect(saveIndicator(failed)).toEqual({ phase: 'failed', label: 'Couldn’t save. Retrying…' });
    expect(hasUnsaved(failed, answers)).toBe(true);
    expect(startSave(failed, answers).request).not.toBeNull();

    expect([1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([
      RETRY_DELAYS_MS[0],
      RETRY_DELAYS_MS[1],
      RETRY_DELAYS_MS[2],
      RETRY_DELAYS_MS[3],
      RETRY_DELAYS_MS[3],
      RETRY_DELAYS_MS[3],
    ]);
  });

  test('a refusal stops saving until the applicant acts', () => {
    const answers = { name: 'Ana' };
    const { state: busy, request } = saving(edited(openDraft(null), answers, answers), answers);

    const refused = finishSave(busy, request, { status: 'refused', message: 'Closed.' }, answers);
    expect(refused).toMatchObject({ phase: 'refused', refusal: 'Closed.' });
    expect(saveIndicator(refused)).toEqual({ phase: 'failed', label: 'Not saved' });
    expect(startSave(refused, answers).request).toBeNull();
    expect(edited(refused, { name: 'Anna' }, { name: 'Anna' }).phase).toBe('refused');

    const retried = retryRefused(refused);
    expect(retried).toMatchObject({ phase: 'unsaved', refusal: null });
    expect(saving(retried, answers).request.expectedRevision).toBeNull();
  });

  test('only an outage or an unexplained error is retried by itself', () => {
    expect(thrownOutcome(new Error('fetch failed')).status).toBe('failed');
    expect(thrownOutcome(new Error("Proton's API did not answer (HTTP 503).")).status).toBe(
      'failed',
    );
    expect(thrownOutcome(new Error('boom')).status).toBe('failed');
    expect(thrownOutcome('boom').status).toBe('failed');
  });

  test('an expired sign-in stops retrying and says to sign in again', () => {
    const signedOut = Object.assign(new Error('not signed in'), { name: 'ForbiddenError' });
    const outcome = thrownOutcome(signedOut);

    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.message).toContain('Your latest answers weren’t saved.');
    expect(outcome.message).toContain('Sign in again in another tab');
  });

  test('answers the server refuses to read stop retrying and say so', () => {
    const issues = JSON.stringify(
      [{ code: 'too_big', maximum: 4000, path: ['answers', 'site'], message: 'Too big' }],
      null,
      2,
    );
    const zod = Object.assign(new Error('Invalid input'), { name: 'ZodError' });

    for (const error of [new Error(issues), zod]) {
      const outcome = thrownOutcome(error);
      expect(outcome.status).toBe('blocked');
      if (outcome.status === 'blocked') expect(outcome.message).toContain('Check your answers');
    }
  });

  test('a blocked save waits for the applicant and retries the same draft', () => {
    const state = openDraft({ revision: 4, answers: { name: 'Ana' }, updatedAt: SAVED_AT });
    const typed = { name: 'Ana Silva' };
    const { state: busy, request } = saving(edited(state, typed, typed), typed);

    const blocked = finishSave(busy, request, thrownOutcome(new Error('not signed in')), typed);
    expect(blocked).toMatchObject({ phase: 'refused', retryable: true, failures: 0 });
    expect(saveIndicator(blocked)).toEqual({ phase: 'failed', label: 'Not saved' });
    expect(startSave(blocked, typed).request).toBeNull();

    const retried = retryRefused(blocked);
    expect(retried).toMatchObject({ phase: 'unsaved', retryable: false, refusal: null });
    expect(saving(retried, typed).request).toEqual({ answers: typed, expectedRevision: 4 });

    const refused = finishSave(busy, request, { status: 'refused', message: 'Gone.' }, typed);
    expect(refused.retryable).toBe(false);
  });

  test('starting over forgets the cleared draft and saves the answers on the page', () => {
    const state = openDraft({ revision: 7, answers: { name: 'Ana' }, updatedAt: SAVED_AT });
    const typed = { name: 'Anna' };
    const { state: busy, request } = saving(edited(state, typed, typed), typed);
    const refused = finishSave(busy, request, { status: 'refused', message: 'Gone.' }, typed);

    const fresh = startOver(refused);
    expect(fresh).toMatchObject({ revision: null, saved: {}, phase: 'unsaved' });
    expect(saving(fresh, { name: 'Anna' }).request).toEqual({
      answers: { name: 'Anna' },
      expectedRevision: null,
    });
  });
});

describe('answers changed on another device', () => {
  const mine = { name: 'Ana', why: 'I like helping' };
  const theirs = {
    revision: 6,
    answers: { name: 'Ana', why: 'Written on my phone' },
    updatedAt: SAVED_AT,
  };

  function conflicted(): DraftState {
    const state = openDraft({ revision: 5, answers: { name: 'Ana' }, updatedAt: SAVED_AT - 1 });
    const { state: busy, request } = saving(edited(state, mine, mine), mine);
    return finishSave(busy, request, { status: 'conflict', draft: theirs }, mine);
  }

  test('a save that lost the race stops and holds both versions', () => {
    const state = conflicted();

    expect(state.phase).toBe('conflict');
    expect(state.newer).toEqual(theirs);
    expect(state.answers).toEqual(mine);
    expect(startSave(state, mine).request).toBeNull();
    expect(hasUnsaved(state, mine)).toBe(true);
  });

  test('using the newer answers replaces the page with them', () => {
    const state = acceptNewer(conflicted());

    expect(state).toMatchObject({
      phase: 'saved',
      revision: 6,
      answers: theirs.answers,
      newer: null,
    });
    expect(hasUnsaved(state, theirs.answers)).toBe(false);
  });

  test('keeping mine re-saves them over the newer revision', () => {
    const state = keepMine(conflicted());

    expect(state).toMatchObject({ phase: 'unsaved', revision: 6, answers: mine, newer: null });
    expect(saving(state, mine).request).toEqual({ answers: mine, expectedRevision: 6 });
  });

  test('keeping mine after a submit conflict sends my answers over the newer revision', () => {
    const desktop = { name: 'Ana', why: 'Written on my desktop' };
    const saved = openDraft({ revision: 5, answers: desktop, updatedAt: SAVED_AT - 1 });

    const conflicted = conflictWith(saved, theirs, desktop);
    expect(conflicted.phase).toBe('conflict');

    const kept = keepMine(conflicted);
    expect(kept).toMatchObject({ phase: 'unsaved', revision: 6, answers: desktop });
    expect(hasUnsaved(kept, desktop)).toBe(true);

    const { state: busy, request } = saving(kept, desktop);
    expect(request).toEqual({ answers: desktop, expectedRevision: 6 });

    const done = finishSave(
      busy,
      request,
      { status: 'saved', revision: 7, savedAt: SAVED_AT },
      desktop,
    );
    expect(done).toMatchObject({ phase: 'saved', revision: 7, saved: desktop });
  });

  test('a refetch with a newer draft replaces clean answers and flags edited ones', () => {
    const saved = openDraft({ revision: 5, answers: { name: 'Ana' }, updatedAt: SAVED_AT - 1 });

    const clean = adoptServer(saved, theirs, { name: 'Ana' });
    expect(clean).toMatchObject({ phase: 'saved', revision: 6, answers: theirs.answers });

    const dirty = adoptServer(edited(saved, mine, mine), theirs, mine);
    expect(dirty).toMatchObject({ phase: 'conflict', newer: theirs, answers: mine });
  });

  test('a refetch of the draft already held changes nothing', () => {
    const saved = openDraft({ revision: 6, answers: theirs.answers, updatedAt: SAVED_AT });

    expect(adoptServer(saved, theirs, theirs.answers)).toBe(saved);
    expect(adoptServer(saved, { ...theirs, revision: 3 }, theirs.answers)).toBe(saved);
    expect(adoptServer(saved, null, theirs.answers)).toBe(saved);
  });

  test('a refetch never interrupts a save in flight', () => {
    const { state: busy } = saving(edited(openDraft(null), mine, mine), mine);
    expect(adoptServer(busy, theirs, mine)).toBe(busy);
  });

  test('a newer draft with the same answers is simply taken as saved', () => {
    const state = edited(openDraft(null), theirs.answers, theirs.answers);

    expect(adoptServer(state, theirs, theirs.answers)).toMatchObject({
      phase: 'saved',
      revision: 6,
    });
    expect(conflictWith(state, theirs, theirs.answers)).toMatchObject({
      phase: 'saved',
      revision: 6,
    });
    expect(conflictWith(state, theirs, mine)).toMatchObject({ phase: 'conflict', newer: theirs });
  });
});

describe('the save timer', () => {
  test('saves once, a moment after typing stops', () => {
    const clock = new FakeClock();
    const timer = new SaveTimer(clock);
    const saves: number[] = [];
    const typed = (): void => timer.schedule(() => saves.push(clock.now), AUTOSAVE_DELAY_MS);

    typed();
    clock.advance(400);
    typed();
    clock.advance(400);
    typed();
    expect(timer.pending).toBe(true);

    clock.advance(AUTOSAVE_DELAY_MS - 1);
    expect(saves).toEqual([]);

    clock.advance(1);
    expect(saves).toEqual([800 + AUTOSAVE_DELAY_MS]);
    expect(timer.pending).toBe(false);

    clock.advance(10_000);
    expect(saves).toHaveLength(1);
  });

  test('leaving a field saves straight away instead of waiting', () => {
    const clock = new FakeClock();
    const timer = new SaveTimer(clock);
    const saves: string[] = [];

    timer.schedule(() => saves.push('debounced'), AUTOSAVE_DELAY_MS);
    timer.cancel();
    saves.push('blur');

    clock.advance(AUTOSAVE_DELAY_MS * 2);
    expect(saves).toEqual(['blur']);
    expect(timer.pending).toBe(false);
  });

  test('a retry waits for its back-off, and a new keystroke replaces it', () => {
    const clock = new FakeClock();
    const timer = new SaveTimer(clock);
    const saves: string[] = [];

    timer.schedule(() => saves.push('retry'), retryDelay(1));
    clock.advance(1_000);
    timer.schedule(() => saves.push('typed'), AUTOSAVE_DELAY_MS);
    clock.advance(retryDelay(1));

    expect(saves).toEqual(['typed']);
  });
});

describe('when the form changed under the page', () => {
  test('a refused or lost save reloads the form, a saved or failed one does not', () => {
    expect(refreshesForm({ status: 'refused', message: 'This form was updated.' })).toBe(true);
    expect(
      refreshesForm({
        status: 'conflict',
        draft: { revision: 2, answers: {}, updatedAt: SAVED_AT },
      }),
    ).toBe(true);
    expect(refreshesForm({ status: 'saved', revision: 2, savedAt: SAVED_AT })).toBe(false);
    expect(refreshesForm({ status: 'failed', message: 'down' })).toBe(false);
    expect(refreshesForm({ status: 'blocked', message: 'Sign in' })).toBe(false);
  });

  test('a problem with a question the page doesn’t show means the form changed', () => {
    const shown = new Set(['name', 'why']);

    expect(problemsOffPage([{ questionId: 'why' }], shown)).toBe(false);
    expect(problemsOffPage([{ questionId: 'why' }, { questionId: 'portfolio' }], shown)).toBe(true);
    expect(problemsOffPage([], shown)).toBe(false);
  });
});

test('request ids fit what the api accepts', () => {
  const ids = new Set(Array.from({ length: 50 }, newRequestId));

  expect(ids.size).toBe(50);
  for (const id of ids) expect(REQUEST_ID.test(id)).toBe(true);
});
