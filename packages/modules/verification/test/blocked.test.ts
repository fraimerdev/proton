import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  BlockedMember,
  BlockedMemberList,
  BlockedMemberQuery,
  BlockedMemberStore,
  BlockMemberInput,
  LiftBlockInput,
  LiftBlockResult,
} from '@proton/core';
import {
  EVERYONE_ROLE,
  GATED,
  GUILD,
  type Harness,
  harness,
  MEMBER,
  UNVERIFIED_ROLE,
  VERIFIED_ROLE,
  verifyPress,
  WEBSITE,
} from './harness.ts';

class MemoryBlockedMemberStore implements BlockedMemberStore {
  readonly live = new Map<string, BlockedMember>();

  block(_input: BlockMemberInput): Promise<{ blocked: boolean }> {
    throw new Error('verification never writes to the blocked list');
  }

  async find(guildId: string, userId: string): Promise<BlockedMember | null> {
    return this.live.get(`${guildId}:${userId}`) ?? null;
  }

  list(_guildId: string, _query: BlockedMemberQuery): Promise<BlockedMemberList> {
    throw new Error('verification never lists the blocked list');
  }

  lift(_input: LiftBlockInput): Promise<LiftBlockResult> {
    throw new Error('verification never lifts from the blocked list');
  }

  add(guildId: string, userId: string): void {
    this.live.set(`${guildId}:${userId}`, {
      id: 'block-1',
      guildId,
      userId,
      moduleId: 'honeypot',
      blockedBy: 'proton:honeypot',
      reason: 'Posted in a honeypot channel.',
      caseId: null,
      evidence: null,
      createdAt: '2026-02-01T12:00:00.000Z',
      liftedAt: null,
      liftedBy: null,
      liftReason: null,
    });
  }
}

let h: Harness;
let blocked: MemoryBlockedMemberStore;

beforeEach(() => {
  h = harness();
  blocked = new MemoryBlockedMemberStore();
  h.deps.blocked = blocked;
  h.memberRoles.set(MEMBER, new Set([EVERYONE_ROLE, UNVERIFIED_ROLE]));
});

function warnings(): string {
  return h.logs
    .filter((line) => line.level === 'warn')
    .map((line) => line.message)
    .join(' ');
}

function errors(): string {
  return h.logs
    .filter((line) => line.level === 'error')
    .map((line) => line.message)
    .join(' ');
}

describe('a member who is not on the list', () => {
  test('verifies exactly as before', async () => {
    expect(await h.press(verifyPress(), { config: GATED })).toEqual({ action: 'verified' });
    expect(h.rolesOf(MEMBER)).toContain(VERIFIED_ROLE);
  });
});

describe('a member on the blocked list', () => {
  beforeEach(() => {
    blocked.add(GUILD, MEMBER);
  });

  test('is refused, and no role is touched', async () => {
    const outcome = await h.press(verifyPress(), { config: GATED });

    expect(outcome.action).toBe('refused');
    expect(h.roleCalls()).toEqual([]);
    expect(h.rolesOf(MEMBER)).not.toContain(VERIFIED_ROLE);
    expect(h.rolesOf(MEMBER)).toContain(UNVERIFIED_ROLE);
  });

  // The reason and the module that wrote it are moderator information. Telling the member which
  // trap caught them tells the next spam bot which channel to avoid.
  test('is told the list exists without being told why or by what', async () => {
    await h.press(verifyPress(), { config: GATED });

    const told = h.lastTold() ?? '';

    expect(told).toContain('blocked list');
    expect(told).not.toContain('honeypot');
    expect(told).not.toContain('Posted in');
  });

  test('the log names both, so a moderator reading it can act', async () => {
    await h.press(verifyPress(), { config: GATED });

    expect(warnings()).toContain('honeypot');
    expect(warnings()).toContain('Posted in a honeypot channel.');
  });

  test('is refused at the slash command too', async () => {
    await h.run('verify', [], { config: GATED, userId: MEMBER });

    expect(h.replyContent()).toContain('blocked list');
    expect(h.roleCalls()).toEqual([]);
  });

  test('is refused after passing on the website, and that is a warning not an error', async () => {
    const outcome = await h.webPassed(
      { guildId: GUILD, userId: MEMBER, jti: 'jti-1', verifiedAt: 1_700_000_000_000 },
      { config: WEBSITE },
    );

    expect(outcome.action).toBe('refused');
    expect(h.roleCalls()).toEqual([]);
    expect(errors()).toBe('');
    expect(warnings()).toContain('blocked list');
  });

  test('a block in another server does not reach this one', async () => {
    blocked.live.clear();
    blocked.add('900000000000000009', MEMBER);

    expect(await h.press(verifyPress(), { config: GATED })).toEqual({ action: 'verified' });
    expect(h.rolesOf(MEMBER)).toContain(VERIFIED_ROLE);
  });
});

// Pinned so that flipping to fail-closed is a deliberate change to this test, not a quiet edit.
describe('when the blocked port was never wired up', () => {
  test('verification still runs, and the missing port is named at error', async () => {
    delete h.deps.blocked;
    blocked.add(GUILD, MEMBER);

    expect(await h.press(verifyPress(), { config: GATED })).toEqual({ action: 'verified' });
    expect(errors()).toContain('blocked');
  });
});
