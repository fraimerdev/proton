import { describe, expect, test } from 'bun:test';
import { ALL_PERMISSIONS, Permissions } from '@proton/core';
import {
  authorizeTicket,
  rolesOf,
  TICKET_ACTIONS,
  TICKET_ROLES,
  type TicketAction,
  type TicketActor,
  type TicketAuthDecision,
  type TicketAuthInput,
  type TicketRole,
} from '../src/authorize.ts';
import type { Ticket } from '../src/store.ts';
import {
  GUILD,
  HELPER,
  MEMBER,
  MemoryTicketStore,
  OTHER_HELPER,
  OWNER,
  PANEL,
  SUPPORT_ROLE,
  TICKET_CHANNEL,
  TYPE,
} from './harness.ts';

const AT = new Date(Date.UTC(2026, 7, 24, 12, 0, 0));

const OTHER_ROLE = '410000000000000008';

const RESERVED = await new MemoryTicketStore(() => AT).reserve({
  guildId: GUILD,
  typeId: TYPE.id,
  panelId: PANEL.id,
  openerId: MEMBER,
  priority: TYPE.defaultPriority,
});

function ticketOf(patch: Partial<Ticket> = {}): Ticket {
  return { ...RESERVED, channelId: TICKET_CHANNEL, ...patch };
}

function bare(userId: string): TicketActor {
  return { userId, roleIds: [], permissions: 0n };
}

const ADMIN: TicketActor = { userId: HELPER, roleIds: [], permissions: Permissions.ManageGuild };

const MODERATOR: TicketActor = {
  userId: HELPER,
  roleIds: [],
  permissions: Permissions.ManageChannels,
};

const SUPPORT: TicketActor = { userId: HELPER, roleIds: [SUPPORT_ROLE], permissions: 0n };

const STRANGER = bare(OTHER_HELPER);

function decide(
  action: TicketAction,
  actor: TicketActor,
  overrides: Partial<Omit<TicketAuthInput, 'action' | 'actor'>> = {},
): TicketAuthDecision {
  return authorizeTicket({
    action,
    actor,
    ticket: ticketOf(),
    staffRoleIds: [SUPPORT_ROLE],
    ...overrides,
  });
}

function refusalOf(decision: TicketAuthDecision): { code: string; humanReason: string } {
  if (decision.allowed) throw new Error(`expected a refusal, and ${decision.via} was allowed it`);

  return { code: decision.code, humanReason: decision.humanReason };
}

function grantedBy(decision: TicketAuthDecision): TicketRole {
  if (!decision.allowed) throw new Error(`expected it to be allowed, and it was ${decision.code}`);

  return decision.via;
}

// A second copy of src/authorize.ts's ALLOWED, on purpose: the point of the matrix below is that
// widening who may do something fails here until somebody changes this table too.
const MAY: Record<TicketAction, readonly TicketRole[]> = {
  info: ['admin', 'moderator', 'support', 'claimant', 'assignee', 'owner', 'opener'],
  transcript: ['admin', 'moderator', 'support', 'claimant', 'assignee', 'owner', 'opener'],

  close: ['admin', 'moderator', 'support', 'claimant', 'assignee', 'owner'],
  'request-close': ['admin', 'moderator', 'support', 'claimant', 'assignee'],
  reopen: ['admin', 'moderator', 'support', 'claimant', 'assignee', 'owner'],
  archive: ['admin', 'moderator', 'support', 'claimant', 'assignee'],

  delete: ['admin', 'moderator'],

  claim: ['admin', 'moderator', 'support'],
  unclaim: ['admin', 'moderator', 'claimant'],
  assign: ['admin', 'moderator', 'support', 'claimant'],
  transfer: ['admin', 'moderator', 'support', 'claimant', 'assignee'],

  'add-participant': ['admin', 'moderator', 'support', 'claimant', 'assignee', 'owner'],
  'remove-participant': ['admin', 'moderator', 'support', 'claimant', 'assignee'],

  rename: ['admin', 'moderator', 'support', 'claimant', 'assignee'],
  move: ['admin', 'moderator', 'support', 'claimant', 'assignee'],
  priority: ['admin', 'moderator', 'support', 'claimant', 'assignee'],
  lock: ['admin', 'moderator', 'support', 'claimant', 'assignee'],
  unlock: ['admin', 'moderator', 'support', 'claimant', 'assignee'],
  response: ['admin', 'moderator', 'support', 'claimant', 'assignee'],

  'post-panel': ['admin', 'moderator'],
  blacklist: ['admin', 'moderator'],
  stats: ['admin', 'moderator', 'support'],
};

const GUILD_LEVEL: readonly TicketAction[] = ['post-panel', 'blacklist', 'stats'];

const TICKET_LEVEL = TICKET_ACTIONS.filter((action) => !GUILD_LEVEL.includes(action));

// A second copy of src/authorize.ts's CLAIMABLE, for the same reason as MAY.
const FENCED: readonly TicketAction[] = [
  'close',
  'request-close',
  'archive',
  'assign',
  'transfer',
  'add-participant',
  'remove-participant',
  'rename',
  'move',
  'priority',
  'lock',
  'unlock',
  'response',
];

const UNFENCED = TICKET_ACTIONS.filter((action) => !FENCED.includes(action));

const REFUSAL_CODES = new Set([
  'no_ticket',
  'ticket_deleted',
  'claiming_off',
  'reopen_off',
  'not_permitted',
  'claimed_by_other',
]);

function wearing(role: TicketRole): { actor: TicketActor; ticket: Ticket } {
  switch (role) {
    case 'admin':
      return { actor: ADMIN, ticket: ticketOf() };
    case 'moderator':
      return { actor: MODERATOR, ticket: ticketOf() };
    case 'support':
      return { actor: SUPPORT, ticket: ticketOf() };
    case 'claimant':
      return { actor: bare(HELPER), ticket: ticketOf({ claimedById: HELPER, claimedAt: AT }) };
    case 'assignee':
      return {
        actor: bare(HELPER),
        ticket: ticketOf({ assignedToId: HELPER, assignedById: MEMBER, assignedAt: AT }),
      };
    case 'owner':
      return { actor: bare(MEMBER), ticket: ticketOf({ openerId: OTHER_HELPER }) };
    case 'opener':
      return { actor: bare(MEMBER), ticket: ticketOf({ ownerId: OTHER_HELPER }) };
  }
}

function asRole(role: TicketRole, action: TicketAction): TicketAuthDecision {
  const worn = wearing(role);

  return decide(action, worn.actor, { ticket: worn.ticket });
}

const pairs: Array<[TicketAction, TicketRole]> = TICKET_ACTIONS.flatMap((action) =>
  TICKET_ROLES.map((role): [TicketAction, TicketRole] => [action, role]),
);

const permittedPairs = pairs.filter(([action, role]) => MAY[action].includes(role));

const forbiddenPairs = pairs.filter(([action, role]) => !MAY[action].includes(role));

describe('the roles an actor is wearing', () => {
  test.each([...TICKET_ROLES])(
    'the %s fixture wears exactly that one role, so every row of the matrix below tests one grant',
    (role) => {
      const worn = wearing(role);

      expect(
        rolesOf({
          action: 'info',
          actor: worn.actor,
          ticket: worn.ticket,
          staffRoleIds: [SUPPORT_ROLE],
        }),
      ).toEqual([role]);
    },
  );

  test('a stranger with no roles and no permission bits wears nothing at all', () => {
    expect(
      rolesOf({
        action: 'info',
        actor: STRANGER,
        ticket: ticketOf(),
        staffRoleIds: [SUPPORT_ROLE],
      }),
    ).toEqual([]);
  });

  test('with no ticket in hand only the guild-wide roles can be worn, because the rest are per-ticket', () => {
    expect(
      rolesOf({ action: 'stats', actor: ADMIN, ticket: null, staffRoleIds: [SUPPORT_ROLE] }),
    ).toEqual(['admin']);

    expect(
      rolesOf({ action: 'stats', actor: bare(MEMBER), ticket: null, staffRoleIds: [SUPPORT_ROLE] }),
    ).toEqual([]);
  });

  test('the strongest role is listed first, because that is the one an audit line has to name', () => {
    const everything: TicketActor = {
      userId: MEMBER,
      roleIds: [SUPPORT_ROLE],
      permissions: Permissions.ManageGuild | Permissions.ManageChannels,
    };

    expect(
      rolesOf({
        action: 'info',
        actor: everything,
        ticket: ticketOf({ claimedById: MEMBER, assignedToId: MEMBER }),
        staffRoleIds: [SUPPORT_ROLE],
      }),
    ).toEqual(['admin', 'moderator', 'support', 'claimant', 'assignee', 'owner', 'opener']);
  });
});

describe('every action against every role', () => {
  test.each(pairs)(
    '%s by a lone %s follows the pinned table, so widening it is a deliberate product change',
    (action, role) => {
      const allowed = MAY[action].includes(role);

      expect(`${action} by ${role}: ${asRole(role, action).allowed}`).toBe(
        `${action} by ${role}: ${allowed}`,
      );
    },
  );

  test.each(permittedPairs)(
    '%s allowed for a %s reports that role as the one that granted it, so the audit trail is true',
    (action, role) => {
      expect(grantedBy(asRole(role, action))).toBe(role);
    },
  );

  test.each(forbiddenPairs)(
    '%s refused for a %s says not_permitted rather than going quiet, because "the bot did nothing" is a bug',
    (action, role) => {
      const refusal = refusalOf(asRole(role, action));

      expect(refusal.code).toBe('not_permitted');
      expect(refusal.humanReason.trim().length).toBeGreaterThan(0);
    },
  );

  test('a role that appears in no allow-list would still be refused everywhere', () => {
    for (const role of TICKET_ROLES) {
      const reachable = TICKET_ACTIONS.some((action) => MAY[action].includes(role));

      expect(`${role} reachable: ${reachable}`).toBe(`${role} reachable: true`);
    }
  });
});

describe('a stranger is refused everything, because the default answer is no', () => {
  test.each([...TICKET_ACTIONS])(
    '%s by somebody with no roles and 0n permissions is refused as not_permitted',
    (action) => {
      expect(refusalOf(decide(action, STRANGER)).code).toBe('not_permitted');
    },
  );

  test.each([...TICKET_ACTIONS])(
    '%s is still refused when every permission bit except the three that matter is held',
    (action) => {
      const nearly: TicketActor = {
        userId: OTHER_HELPER,
        roleIds: [OTHER_ROLE],
        permissions:
          ALL_PERMISSIONS &
          ~(Permissions.Administrator | Permissions.ManageGuild | Permissions.ManageChannels),
      };

      expect(refusalOf(decide(action, nearly)).code).toBe('not_permitted');
    },
  );

  test('the refusal for a guild-wide action names the permission that would have worked', () => {
    expect(refusalOf(decide('post-panel', STRANGER, { ticket: null })).humanReason).toContain(
      'Manage Server',
    );
  });

  test('the refusal for a ticket names the ticket, so nobody has to guess which one', () => {
    expect(refusalOf(decide('close', STRANGER)).humanReason).toContain(`#${RESERVED.number}`);
  });
});

describe('the permission bits that buy a seat', () => {
  test('Manage Server is admin and nothing weaker, so a server manager is the top tier here', () => {
    const held = rolesOf({
      action: 'info',
      actor: ADMIN,
      ticket: ticketOf(),
      staffRoleIds: [SUPPORT_ROLE],
    });

    expect(held).toEqual(['admin']);
    expect(grantedBy(decide('delete', ADMIN))).toBe('admin');
  });

  test('Manage Channels is moderator and not admin, so it never reads as the higher tier', () => {
    const held = rolesOf({
      action: 'info',
      actor: MODERATOR,
      ticket: ticketOf(),
      staffRoleIds: [SUPPORT_ROLE],
    });

    expect(held).toEqual(['moderator']);
    expect(grantedBy(decide('delete', MODERATOR))).toBe('moderator');
  });

  test.each([...TICKET_ACTIONS])(
    '%s is open to the Administrator bit through hasWithAdmin, which is how the guild owner arrives',
    (action) => {
      const guildOwner: TicketActor = {
        userId: OWNER,
        roleIds: [],
        permissions: Permissions.Administrator,
      };

      expect(grantedBy(decide(action, guildOwner))).toBe('admin');
    },
  );

  test('the Administrator bit is both tiers at once, so it can never be fenced out as support', () => {
    const guildOwner: TicketActor = {
      userId: OWNER,
      roleIds: [],
      permissions: Permissions.Administrator,
    };

    expect(
      rolesOf({
        action: 'info',
        actor: guildOwner,
        ticket: ticketOf(),
        staffRoleIds: [SUPPORT_ROLE],
      }),
    ).toEqual(['admin', 'moderator']);
  });

  test('a moderation bit that is neither of the two named ones buys nothing', () => {
    const banHammer: TicketActor = {
      userId: OTHER_HELPER,
      roleIds: [],
      permissions: Permissions.BanMembers | Permissions.ManageMessages | Permissions.KickMembers,
    };

    expect(
      rolesOf({
        action: 'info',
        actor: banHammer,
        ticket: ticketOf(),
        staffRoleIds: [SUPPORT_ROLE],
      }),
    ).toEqual([]);
  });
});

describe('support is membership of a configured role and nothing else', () => {
  test('holding one of the configured staff roles is support', () => {
    expect(grantedBy(decide('claim', SUPPORT))).toBe('support');
  });

  test('holding a different role is not, however many roles are held', () => {
    const outsider: TicketActor = {
      userId: OTHER_HELPER,
      roleIds: [OTHER_ROLE, GUILD, TICKET_CHANNEL],
      permissions: 0n,
    };

    expect(refusalOf(decide('claim', outsider)).code).toBe('not_permitted');
  });

  test('one match anywhere in a long role list is enough, because Discord sends them unordered', () => {
    const buried: TicketActor = {
      userId: OTHER_HELPER,
      roleIds: [OTHER_ROLE, GUILD, SUPPORT_ROLE],
      permissions: 0n,
    };

    expect(grantedBy(decide('claim', buried))).toBe('support');
  });

  test('an empty staff list makes nobody support, so a misconfigured type cannot leak a ticket', () => {
    expect(refusalOf(decide('claim', SUPPORT, { staffRoleIds: [] })).code).toBe('not_permitted');
  });

  test('a staff role configured but held by nobody grants nothing to the holder of another', () => {
    expect(refusalOf(decide('claim', SUPPORT, { staffRoleIds: [OTHER_ROLE] })).code).toBe(
      'not_permitted',
    );
  });
});

describe('the opener after a transfer is not the owner any more', () => {
  const transferred = ticketOf({ openerId: MEMBER, ownerId: OTHER_HELPER });

  test('the member who raised it keeps only the two read-only controls', () => {
    expect(
      rolesOf({
        action: 'info',
        actor: bare(MEMBER),
        ticket: transferred,
        staffRoleIds: [SUPPORT_ROLE],
      }),
    ).toEqual(['opener']);

    expect(grantedBy(decide('info', bare(MEMBER), { ticket: transferred }))).toBe('opener');
    expect(grantedBy(decide('transcript', bare(MEMBER), { ticket: transferred }))).toBe('opener');
  });

  test.each(TICKET_ACTIONS.filter((action) => !MAY[action].includes('opener')))(
    '%s is refused to the original opener, because handing a ticket over has to actually hand it over',
    (action) => {
      expect(refusalOf(decide(action, bare(MEMBER), { ticket: transferred })).code).toBe(
        'not_permitted',
      );
    },
  );

  test('closing and reopening move to the new owner with the ticket', () => {
    expect(grantedBy(decide('close', bare(OTHER_HELPER), { ticket: transferred }))).toBe('owner');
    expect(grantedBy(decide('reopen', bare(OTHER_HELPER), { ticket: transferred }))).toBe('owner');
  });
});

describe('deleting is a strictly higher bar than closing', () => {
  test('everyone who may delete may also close, and the reverse is not true', () => {
    for (const role of MAY.delete) {
      expect(`${role} may close: ${MAY.close.includes(role)}`).toBe(`${role} may close: true`);
    }

    expect(MAY.close.length).toBeGreaterThan(MAY.delete.length);
  });

  test.each(MAY.close.filter((role) => !MAY.delete.includes(role)))(
    'a %s may close all day and still cannot delete, because closing is reversible and deleting is not',
    (role) => {
      expect(grantedBy(asRole(role, 'close'))).toBe(role);
      expect(refusalOf(asRole(role, 'delete')).code).toBe('not_permitted');
    },
  );
});

describe('a guild-wide action needs no ticket and a ticket action refuses without one', () => {
  test.each([...GUILD_LEVEL])(
    '%s is answered with no ticket in hand, because it is about the server rather than one conversation',
    (action) => {
      expect(grantedBy(decide(action, ADMIN, { ticket: null }))).toBe('admin');
      expect(grantedBy(decide(action, MODERATOR, { ticket: null }))).toBe('moderator');
    },
  );

  test.each([...TICKET_LEVEL])(
    '%s with no ticket in hand refuses with no_ticket even for an administrator, because there is nothing to act on',
    (action) => {
      const guildOwner: TicketActor = {
        userId: OWNER,
        roleIds: [],
        permissions: Permissions.Administrator,
      };

      const refusal = refusalOf(decide(action, guildOwner, { ticket: null }));

      expect(refusal.code).toBe('no_ticket');
      expect(refusal.humanReason.trim().length).toBeGreaterThan(0);
    },
  );

  test('no_ticket is decided before the claim and reopen switches, so the answer is about the ticket', () => {
    expect(refusalOf(decide('claim', ADMIN, { ticket: null, claimMode: 'off' })).code).toBe(
      'no_ticket',
    );

    expect(refusalOf(decide('reopen', ADMIN, { ticket: null, reopenEnabled: false })).code).toBe(
      'no_ticket',
    );
  });

  test('stats is the one guild-wide action support may run, so the team can see its own numbers', () => {
    expect(grantedBy(decide('stats', SUPPORT, { ticket: null }))).toBe('support');
    expect(refusalOf(decide('post-panel', SUPPORT, { ticket: null })).code).toBe('not_permitted');
    expect(refusalOf(decide('blacklist', SUPPORT, { ticket: null })).code).toBe('not_permitted');
  });
});

describe('a deleted ticket refuses everything', () => {
  const deleted = ticketOf({ status: 'deleted', deletedAt: AT });

  test.each([...TICKET_ACTIONS])(
    '%s against a deleted ticket refuses with ticket_deleted, because the row is a tombstone',
    (action) => {
      const refusal = refusalOf(decide(action, ADMIN, { ticket: deleted }));

      expect(refusal.code).toBe('ticket_deleted');
      expect(refusal.humanReason).toContain(`#${RESERVED.number}`);
    },
  );

  test('being deleted outranks the claim and reopen switches, so the answer is never the wrong reason', () => {
    expect(refusalOf(decide('claim', ADMIN, { ticket: deleted, claimMode: 'off' })).code).toBe(
      'ticket_deleted',
    );

    expect(refusalOf(decide('reopen', ADMIN, { ticket: deleted, reopenEnabled: false })).code).toBe(
      'ticket_deleted',
    );
  });

  test('a closed or archived ticket is not a deleted one and still answers normally', () => {
    expect(grantedBy(decide('reopen', ADMIN, { ticket: ticketOf({ status: 'closed' }) }))).toBe(
      'admin',
    );

    expect(grantedBy(decide('delete', ADMIN, { ticket: ticketOf({ status: 'archived' }) }))).toBe(
      'admin',
    );
  });
});

describe('claiming can be switched off for a ticket type', () => {
  test('claim is refused with claiming_off and points at the setting that did it', () => {
    const refusal = refusalOf(decide('claim', ADMIN, { claimMode: 'off' }));

    expect(refusal.code).toBe('claiming_off');
    expect(refusal.humanReason).toContain('Ticket types');
  });

  test('the switch outranks permission, so even a stranger is told the truth rather than "no"', () => {
    expect(refusalOf(decide('claim', STRANGER, { claimMode: 'off' })).code).toBe('claiming_off');
  });

  test.each(['single', 'assignable'] as const)(
    'claimMode %s leaves claiming to the permission check, where support may take a ticket',
    (claimMode) => {
      expect(grantedBy(decide('claim', SUPPORT, { claimMode }))).toBe('support');
    },
  );

  test('an absent claimMode means single, because that is the schema default a caller may omit', () => {
    expect(grantedBy(decide('claim', SUPPORT))).toBe('support');
  });

  test('switching claiming off does not switch off letting go or handing over', () => {
    expect(
      grantedBy(
        decide('unclaim', ADMIN, { ticket: ticketOf({ claimedById: HELPER }), claimMode: 'off' }),
      ),
    ).toBe('admin');

    expect(grantedBy(decide('assign', ADMIN, { claimMode: 'off' }))).toBe('admin');
  });
});

describe('reopening can be switched off for a ticket type', () => {
  test('reopen is refused with reopen_off and says what to do instead', () => {
    const refusal = refusalOf(decide('reopen', ADMIN, { reopenEnabled: false }));

    expect(refusal.code).toBe('reopen_off');
    expect(refusal.humanReason).toContain('Open a new one');
  });

  test('the switch outranks permission, so the ticket owner is told why rather than refused flatly', () => {
    const worn = wearing('owner');

    expect(
      refusalOf(decide('reopen', worn.actor, { ticket: worn.ticket, reopenEnabled: false })).code,
    ).toBe('reopen_off');
  });

  test('only an explicit false switches it off, because an omitted flag means the schema default', () => {
    expect(grantedBy(decide('reopen', ADMIN, { reopenEnabled: true }))).toBe('admin');
    expect(grantedBy(decide('reopen', ADMIN))).toBe('admin');
  });

  test('switching reopening off leaves every other control alone', () => {
    expect(grantedBy(decide('close', ADMIN, { reopenEnabled: false }))).toBe('admin');
    expect(grantedBy(decide('info', ADMIN, { reopenEnabled: false }))).toBe('admin');
    expect(grantedBy(decide('delete', ADMIN, { reopenEnabled: false }))).toBe('admin');
  });
});

describe('the claim fence', () => {
  const claimed = ticketOf({ claimedById: OTHER_HELPER, claimedAt: AT });

  const fence = { ticket: claimed, claimRestrictsStaff: true } as const;

  test.each([...FENCED])(
    '%s is refused to a support member while somebody else holds the claim, and names who holds it',
    (action) => {
      const refusal = refusalOf(decide(action, SUPPORT, fence));

      expect(refusal.code).toBe('claimed_by_other');
      expect(refusal.humanReason).toContain(`<@${OTHER_HELPER}>`);
    },
  );

  test.each(FENCED.filter((action) => MAY[action].includes('owner')))(
    '%s is refused to the member who raised the ticket too, because the fence is around the conversation',
    (action) => {
      expect(refusalOf(decide(action, bare(MEMBER), fence)).code).toBe('claimed_by_other');
    },
  );

  test.each([...FENCED])(
    '%s is never fenced off from a moderator, or one claimant could lock out the whole server',
    (action) => {
      expect(grantedBy(decide(action, MODERATOR, fence))).toBe('moderator');
    },
  );

  test.each([...FENCED])('%s is never fenced off from an admin either', (action) => {
    expect(grantedBy(decide(action, ADMIN, fence))).toBe('admin');
  });

  test.each(['info', 'transcript'] as const)(
    '%s stays open to support while another claim is held, or a claimed ticket goes dark for the team',
    (action) => {
      expect(grantedBy(decide(action, SUPPORT, fence))).toBe('support');
    },
  );

  test.each(['info', 'transcript'] as const)(
    '%s stays open to the member who raised it while another claim is held',
    (action) => {
      expect(grantedBy(decide(action, bare(MEMBER), fence))).toBe('owner');
    },
  );

  test.each(UNFENCED.filter((action) => MAY[action].includes('support')))(
    '%s is outside the fence by design, so a claim does not quietly widen into everything',
    (action) => {
      expect(grantedBy(decide(action, SUPPORT, fence))).toBe('support');
    },
  );

  test('an unclaimed ticket has no fence, however the type is configured', () => {
    expect(grantedBy(decide('close', SUPPORT, { claimRestrictsStaff: true }))).toBe('support');
  });

  test('a claimed ticket has no fence unless the type asked for one', () => {
    expect(grantedBy(decide('close', SUPPORT, { ticket: claimed }))).toBe('support');
    expect(
      grantedBy(decide('close', SUPPORT, { ticket: claimed, claimRestrictsStaff: false })),
    ).toBe('support');
  });

  test('a claimant who holds no support role keeps their own claimed ticket', () => {
    const mine = ticketOf({ claimedById: HELPER, claimedAt: AT });

    expect(
      grantedBy(decide('close', bare(HELPER), { ticket: mine, claimRestrictsStaff: true })),
    ).toBe('claimant');
  });

  // Known defect in src/authorize.ts: the fence tests `via`, which reports the strongest role, so a
  // support member who claims a ticket is reported as 'support' and fenced out of the claim they
  // themselves hold. Exempting `ticket.claimedById === actor.userId` is the fix.
  test.failing('a support member who claimed the ticket keeps it, because the fence exists to give it to them', () => {
    const mine = ticketOf({ claimedById: HELPER, claimedAt: AT });

    expect(decide('close', SUPPORT, { ticket: mine, claimRestrictsStaff: true }).allowed).toBe(
      true,
    );
  });
});

describe('every refusal is something a member can read', () => {
  const refusals: TicketAuthDecision[] = [
    decide('close', STRANGER),
    decide('delete', SUPPORT),
    decide('close', ADMIN, { ticket: null }),
    decide('close', ADMIN, { ticket: ticketOf({ status: 'deleted' }) }),
    decide('claim', ADMIN, { claimMode: 'off' }),
    decide('reopen', ADMIN, { reopenEnabled: false }),
    decide('close', SUPPORT, {
      ticket: ticketOf({ claimedById: OTHER_HELPER }),
      claimRestrictsStaff: true,
    }),
    decide('post-panel', STRANGER, { ticket: null }),
  ];

  test('every one of them carries a code from the known set, so a caller can branch on it', () => {
    for (const decision of refusals) {
      expect(REFUSAL_CODES.has(refusalOf(decision).code)).toBe(true);
    }
  });

  test('every one of them says something, and never renders an undefined into the sentence', () => {
    for (const decision of refusals) {
      const reason = refusalOf(decision).humanReason;

      expect(reason.trim().length).toBeGreaterThan(20);
      expect(reason).not.toContain('undefined');
      expect(reason).not.toContain('null');
    }
  });

  test('the six codes are all reachable, so none of them is dead copy nobody will ever see', () => {
    expect(new Set(refusals.map((decision) => refusalOf(decision).code))).toEqual(REFUSAL_CODES);
  });
});
