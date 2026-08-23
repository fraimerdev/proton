import { describe, expect, test } from 'bun:test';
import { evaluateRequirement, type MemberContext, ProviderRegistry } from '@proton/core';
import type { CaseCountQuery, CaseHistoryStore } from '../src/history.ts';
import { createCasesProviders } from '../src/providers.ts';

const GUILD = '100000000000000000';
const USER_A = '400000000000000001';
const NOW = new Date('2026-08-14T12:00:00.000Z');

interface CaseRow {
  targetId: string;
  type: string;
  createdAt: Date;
  expiresAt: Date | null;
  revertedAt: Date | null;
}

class FakeCaseHistory implements CaseHistoryStore {
  readonly queries: CaseCountQuery[] = [];

  constructor(private readonly rows: CaseRow[]) {}

  async countByTarget(query: CaseCountQuery): Promise<Map<string, number>> {
    this.queries.push(query);

    const wanted = new Set(query.userIds);
    const types = new Set(query.types);
    const counts = new Map<string, number>();

    for (const row of this.rows) {
      if (!wanted.has(row.targetId) || !types.has(row.type)) continue;
      if (query.since && row.createdAt < query.since) continue;

      if (query.activeAt) {
        if (row.revertedAt !== null) continue;
        if (row.expiresAt !== null && row.expiresAt < query.activeAt) continue;
      }

      counts.set(row.targetId, (counts.get(row.targetId) ?? 0) + 1);
    }

    return counts;
  }
}

function ctx(userId: string): MemberContext {
  return {
    guildId: GUILD,
    userId,
    member: {
      joinedAt: new Date('2024-01-01T00:00:00.000Z'),
      roleIds: [],
      premiumSince: null,
      communicationDisabledUntil: null,
    },
    user: { createdAt: new Date('2020-01-01T00:00:00.000Z'), hasAvatar: true, bot: false },
    tier: 'free',
    now: NOW,
  };
}

function registryFor(history: CaseHistoryStore): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register({ id: 'cases', providers: createCasesProviders(history) });
  return registry;
}

function caseRow(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    targetId: USER_A,
    type: 'timeout',
    createdAt: new Date('2026-08-13T00:00:00.000Z'),
    expiresAt: null,
    revertedAt: null,
    ...overrides,
  };
}

describe('cases.no_active_case', () => {
  const spec = [{ providerId: 'cases.no_active_case', config: { types: ['timeout', 'ban'] } }];

  test('a clean member passes', async () => {
    const verdict = await evaluateRequirement(
      registryFor(new FakeCaseHistory([])),
      ctx(USER_A),
      spec,
      'all',
    );

    expect(verdict.passed).toBe(true);
  });

  test('a member under an active timeout fails', async () => {
    const verdict = await evaluateRequirement(
      registryFor(new FakeCaseHistory([caseRow()])),
      ctx(USER_A),
      spec,
      'all',
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0]?.humanReason).toContain('currently under a moderation action');
  });

  test('a case that has since expired no longer counts', async () => {
    const expired = caseRow({ expiresAt: new Date('2026-08-01T00:00:00.000Z') });

    const verdict = await evaluateRequirement(
      registryFor(new FakeCaseHistory([expired])),
      ctx(USER_A),
      spec,
      'all',
    );

    expect(verdict.passed).toBe(true);
  });

  test('a reverted case no longer counts', async () => {
    const reverted = caseRow({ revertedAt: new Date('2026-08-13T06:00:00.000Z') });

    const verdict = await evaluateRequirement(
      registryFor(new FakeCaseHistory([reverted])),
      ctx(USER_A),
      spec,
      'all',
    );

    expect(verdict.passed).toBe(true);
  });

  test('a kind the host did not choose is not counted', async () => {
    const warn = caseRow({ type: 'warn' });

    const verdict = await evaluateRequirement(
      registryFor(new FakeCaseHistory([warn])),
      ctx(USER_A),
      spec,
      'all',
    );

    expect(verdict.passed).toBe(true);
  });

  test('it asks only for cases still in force', async () => {
    const history = new FakeCaseHistory([]);
    await evaluateRequirement(registryFor(history), ctx(USER_A), spec, 'all');

    expect(history.queries[0]?.activeAt).toEqual(NOW);
    expect(history.queries[0]?.since).toBeUndefined();
  });
});

describe('cases.no_cases_in', () => {
  const spec = [
    { providerId: 'cases.no_cases_in', config: { days: 30, types: ['warn', 'timeout'] } },
  ];

  test('an old case falls outside the window', async () => {
    const old = caseRow({ type: 'warn', createdAt: new Date('2025-01-01T00:00:00.000Z') });

    const verdict = await evaluateRequirement(
      registryFor(new FakeCaseHistory([old])),
      ctx(USER_A),
      spec,
      'all',
    );

    expect(verdict.passed).toBe(true);
  });

  test('a recent case fails and is counted in the reason', async () => {
    const rows = [caseRow({ type: 'warn' }), caseRow({ type: 'timeout' })];

    const verdict = await evaluateRequirement(
      registryFor(new FakeCaseHistory(rows)),
      ctx(USER_A),
      spec,
      'all',
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0]?.humanReason).toContain('2 moderation actions');
  });

  test('a reverted case still counts against a recent record', async () => {
    const reverted = caseRow({ type: 'warn', revertedAt: new Date('2026-08-13T06:00:00.000Z') });

    const verdict = await evaluateRequirement(
      registryFor(new FakeCaseHistory([reverted])),
      ctx(USER_A),
      spec,
      'all',
    );

    expect(verdict.passed).toBe(false);
  });

  test('the window is measured back from the evaluation time', async () => {
    const history = new FakeCaseHistory([]);
    await evaluateRequirement(registryFor(history), ctx(USER_A), spec, 'all');

    const since = history.queries[0]?.since;
    expect(since).toEqual(new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000));
  });
});

describe('registration', () => {
  test('both providers are query-backed and answer for a batch', () => {
    for (const provider of createCasesProviders(new FakeCaseHistory([]))) {
      expect(provider.cost).toBe('query');
      expect(provider.batchEvaluate).toBeDefined();
      expect(provider.builder.length).toBeLessThanOrEqual(5);
    }
  });
});
