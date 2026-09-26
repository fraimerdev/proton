import { describe, expect, test } from 'bun:test';
import { type JsonValue, Permissions } from '@proton/core';
import {
  acceptParams,
  actionFailure,
  actorLabel,
  allowedPunishments,
  attachmentExpiry,
  cardProblem,
  closeFailed,
  deletesByDefault,
  describeEvent,
  filedByViewer,
  fileSize,
  groupLine,
  historyLine,
  purgeNotice,
  readableOutcome,
  relativeTime,
  statusTone,
} from '../src/pages/moderation/reports/queue-labels.ts';

const NOW = Date.parse('2026-09-18T14:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MEMBER = '400000000000000001';

function event(kind: string, data: Record<string, JsonValue> = {}) {
  return { kind, data };
}

describe('report status badges', () => {
  test('each status has its own tone', () => {
    expect(statusTone('open')).toBe('info');
    expect(statusTone('in_review')).toBe('primary');
    expect(statusTone('accepted')).toBe('success');
    expect(statusTone('dismissed')).toBe('neutral');
  });

  test('a failed or deleted card is a delivery problem, anything else is not', () => {
    expect(cardProblem('failed')).toBe('Delivery failed');
    expect(cardProblem('missing')).toBe('Card missing');
    for (const state of ['pending', 'posted', 'moved', 'deleted', 'closing'] as const) {
      expect(cardProblem(state)).toBeNull();
    }
  });

  test('a close failed only while the card is still waiting to be closed', () => {
    const close = { action: 'move' as const, dueAt: NOW, attempts: 2 };
    expect(closeFailed({ ...close, closedAt: null, error: 'No access' })).toBe(true);
    expect(closeFailed({ ...close, closedAt: NOW, error: 'No access' })).toBe(false);
    expect(closeFailed({ ...close, closedAt: null, error: null })).toBe(false);
  });
});

describe('timeline sentences', () => {
  test('a submission names how it was filed', () => {
    expect(describeEvent(event('submitted', { method: 'message_menu' })).text).toBe(
      'Report filed via Apps → Report message',
    );
    expect(describeEvent(event('submitted')).text).toBe('Report filed');
  });

  test('an assignment points at the member it went to', () => {
    expect(describeEvent(event('assigned', { assigneeId: MEMBER }))).toEqual({
      text: 'Assigned to',
      member: MEMBER,
    });
    expect(describeEvent(event('assigned', { assigneeId: null })).text).toBe('Assignment cleared');
  });

  test('decisions carry the punishment and the case', () => {
    expect(describeEvent(event('accepted', { kind: 'ban', caseId: 'K7f3M2q' }))).toEqual({
      text: 'Accepted with a ban',
      caseId: 'K7f3M2q',
    });
    expect(describeEvent(event('accepted', { kind: 'none' })).text).toBe(
      'Accepted without a punishment',
    );
    expect(describeEvent(event('action_executed', { kind: 'warn', caseId: 'A1' })).text).toBe(
      'Warning carried out',
    );
    expect(describeEvent(event('dismissed')).text).toBe('Dismissed');
  });

  test('failures keep Proton’s reason as the detail line', () => {
    const failed = describeEvent(
      event('action_failed', { kind: 'timeout', code: 'missing_permission', message: 'No.' }),
    );
    expect(failed.text).toBe('Timeout failed, so the report stayed open');
    expect(failed.detail).toBe('No.');

    expect(describeEvent(event('delivery_failed', { error: 'Missing Access' })).detail).toBe(
      'Missing Access',
    );
  });

  test('reporter DMs say what the reporter was told, or why they were not', () => {
    expect(describeEvent(event('notified', { kind: 'dismissed' })).text).toBe(
      'Reporter told the report was dismissed',
    );
    expect(describeEvent(event('notification_failed', { outcome: 'closed' }))).toEqual({
      text: 'Reporter DM not delivered',
      detail: 'Their DMs are closed to Proton.',
    });
    expect(describeEvent(event('notification_failed', { outcome: 'no_mutual_server' }))).toEqual({
      text: 'Reporter DM not delivered',
      detail: 'They no longer share a server with Proton.',
    });
  });

  test('a move that kept the forwarded copy says so', () => {
    expect(describeEvent(event('moved', { copyKept: true }))).toEqual({
      text: 'Report card moved to the archive channel',
      detail: 'The forwarded copy of the message stayed in the report channel.',
    });
    expect(describeEvent(event('moved')).detail).toBeUndefined();
  });

  test('card and retention events read as sentences', () => {
    expect(describeEvent(event('card_missing')).text).toBe('Report card deleted in Discord');
    expect(describeEvent(event('reposted')).text).toBe('Report card posted again');
    expect(describeEvent(event('automation_fired', { ruleName: 'Mass reports' })).text).toBe(
      'Automation rule “Mass reports” fired',
    );
    expect(describeEvent(event('evidence_purged')).text).toBe(
      'Evidence removed after the retention period',
    );
  });

  test('the worker’s own payloads read as sentences too', () => {
    expect(
      describeEvent(event('automation_fired', { ruleId: 'r1', runId: 'x' }), (id) =>
        id === 'r1' ? 'Three strikes' : undefined,
      ).text,
    ).toBe('Automation rule “Three strikes” fired');
    expect(describeEvent(event('automation_fired', { ruleId: 'gone' })).text).toBe(
      'Automation rule fired',
    );
    expect(describeEvent(event('delivery_failed', { code: 'no_channel', attempt: 1 })).detail).toBe(
      'No report channel is set in Report settings.',
    );
    expect(
      describeEvent(event('notified', { notification: 'accepted', outcome: 'sent' })).text,
    ).toBe('Reporter told the report was accepted');
    expect(
      describeEvent(event('accepted', { kind: null, caseIds: [], internalNote: false })).text,
    ).toBe('Accepted without a punishment');
  });

  test('an unknown kind is spelled out, never dumped as data', () => {
    const described = describeEvent(event('something_new', { nested: { secret: 1 } }));
    expect(described.text).toBe('Something new');
    expect(JSON.stringify(described)).not.toContain('secret');
  });

  test('pseudo-actors read as Proton, members are left to the member cell', () => {
    expect(actorLabel(null)).toBeNull();
    expect(actorLabel(MEMBER)).toBeNull();
    expect(actorLabel('proton:reports')).toBe('Proton');
  });
});

describe('attachment links', () => {
  test('a link with no known expiry says only where it comes from', () => {
    expect(attachmentExpiry(null, NOW)).toEqual({ expired: false, label: 'Link from Discord' });
  });

  test('a live link says when it expires', () => {
    expect(attachmentExpiry(NOW + 5 * HOUR, NOW)).toEqual({
      expired: false,
      label: 'Link from Discord, expires in 5h',
    });
  });

  test('a lapsed link says so', () => {
    expect(attachmentExpiry(NOW - 1, NOW)).toEqual({ expired: true, label: 'Link expired' });
    expect(attachmentExpiry(NOW, NOW).expired).toBe(true);
  });

  test('sizes are readable', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(20_480)).toBe('20 KB');
    expect(fileSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  test('relative times go both ways', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 2 * HOUR, NOW)).toBe('2h ago');
    expect(relativeTime(NOW + 3 * 86_400_000, NOW)).toBe('in 3d');
  });
});

function viewer(permissions: bigint, owner = false) {
  return { id: MEMBER, owner, permissions: permissions.toString() };
}

describe('the punishment list', () => {
  test('the owner and an unknown viewer see every punishment', () => {
    expect(allowedPunishments(undefined)).toEqual(['none', 'warn', 'timeout', 'kick', 'ban']);
    expect(allowedPunishments(viewer(0n, true))).toEqual([
      'none',
      'warn',
      'timeout',
      'kick',
      'ban',
    ]);
  });

  test('others see only what their permissions allow', () => {
    expect(allowedPunishments(viewer(Permissions.ModerateMembers))).toEqual([
      'none',
      'warn',
      'timeout',
    ]);
    expect(allowedPunishments(viewer(Permissions.BanMembers))).toEqual(['none', 'ban']);
    expect(allowedPunishments(viewer(Permissions.Administrator))).toEqual([
      'none',
      'warn',
      'timeout',
      'kick',
      'ban',
    ]);
  });
});

describe('deleting the reported message on accept', () => {
  test('follows the punishment’s Delete proof message setting', () => {
    const manager = viewer(Permissions.ManageMessages | Permissions.BanMembers);

    expect(deletesByDefault(true, manager)).toBe(true);
    expect(deletesByDefault(false, manager)).toBe(false);
    expect(deletesByDefault(true, undefined)).toBe(true);
    expect(deletesByDefault(true, viewer(0n, true))).toBe(true);
    expect(deletesByDefault(true, viewer(Permissions.Administrator))).toBe(true);
  });

  test('is not pre-ticked for someone Discord would refuse', () => {
    expect(deletesByDefault(true, viewer(Permissions.BanMembers | Permissions.ManageGuild))).toBe(
      false,
    );
  });
});

describe('what Accept sends', () => {
  const choices = {
    punishment: 'ban' as const,
    reason: '  Scam links  ',
    timeoutFor: '1h',
    banFor: null,
    deleteMessage: null,
    note: '',
    reporterNote: null,
    confirmRecentCase: false,
  };

  test('a permanent ban says so, even where bans have a default length', () => {
    expect(acceptParams(choices)).toEqual({
      punishment: 'ban',
      reason: 'Scam links',
      duration: null,
    });
    expect(acceptParams({ ...choices, banFor: '7d' }).duration).toBe('7d');
  });

  test('a timeout carries its length; warn, kick and none carry none', () => {
    expect(acceptParams({ ...choices, punishment: 'timeout' }).duration).toBe('1h');
    for (const punishment of ['warn', 'kick', 'none'] as const) {
      expect(acceptParams({ ...choices, punishment })).not.toHaveProperty('duration');
    }
  });

  test('accepting without a punishment can still delete the message, and sends no reason', () => {
    expect(acceptParams({ ...choices, punishment: 'none', deleteMessage: true })).toEqual({
      punishment: 'none',
      deleteMessage: true,
    });
  });

  test('the delete choice is sent as made, and left out when there is no message', () => {
    expect(acceptParams({ ...choices, deleteMessage: false }).deleteMessage).toBe(false);
    expect(acceptParams(choices)).not.toHaveProperty('deleteMessage');
  });

  test('notes are trimmed, and the reporter note only goes when its field is shown', () => {
    const noted = { ...choices, note: ' checked ', reporterNote: ' thanks ' };
    expect(acceptParams(noted)).toMatchObject({ note: 'checked', reporterNote: 'thanks' });
    expect(acceptParams({ ...noted, reporterNote: null })).not.toHaveProperty('reporterNote');
    expect(acceptParams({ ...choices, confirmRecentCase: true }).confirmRecentCase).toBe(true);
  });
});

describe('reports the viewer filed', () => {
  const report = { reporterId: MEMBER };

  test('are theirs unless they own the server', () => {
    expect(filedByViewer(report, viewer(Permissions.ManageGuild))).toBe(true);
    expect(filedByViewer(report, viewer(Permissions.ManageGuild, true))).toBe(false);
    expect(filedByViewer({ reporterId: '400000000000000009' }, viewer(0n))).toBe(false);
  });

  test('an unknown viewer or Discord id hides nothing', () => {
    expect(filedByViewer(report, undefined)).toBe(false);
    expect(filedByViewer(report, { ...viewer(0n), id: null })).toBe(false);
  });
});

describe('summary lines', () => {
  test('a member group never merges its reports into one', () => {
    expect(groupLine({ total: 5, distinctReporters: 3, open: 2 })).toBe(
      '5 reports · from 3 members · 2 open',
    );
    expect(groupLine({ total: 1, distinctReporters: 1, open: 0 })).toBe(
      '1 report · from 1 member · 0 open',
    );
  });

  test('history does not count the open report being read', () => {
    const stats = { total: 3, distinctReporters: 2, open: 2 };
    expect(historyLine(stats, true)).toBe(
      'Reported 3 times by 2 members in 30 days · 1 other open',
    );
    expect(historyLine({ ...stats, open: 1 }, true)).toBe(
      'Reported 3 times by 2 members in 30 days · no other open reports',
    );
  });

  test('purged evidence says which clock removed it', () => {
    const filed = NOW - 100 * DAY;
    const base = { evidence: {}, evidencePurgedAt: null, createdAt: filed, resolvedAt: null };
    expect(purgeNotice(base)).toBeNull();
    expect(
      purgeNotice({ ...base, evidencePurgedAt: filed + 40 * DAY, resolvedAt: filed + 10 * DAY }),
    ).toBe('Evidence was removed 30 days after this report was resolved.');
    expect(purgeNotice({ ...base, evidence: { purged: true } })).toBe(
      'Evidence was removed 90 days after this report was filed.',
    );
  });

  test('a report resolved late lost its evidence to the 90-day clock', () => {
    const filed = NOW - 100 * DAY;
    const base = { evidence: { purged: true }, evidencePurgedAt: filed + 90 * DAY };

    expect(purgeNotice({ ...base, createdAt: filed, resolvedAt: filed + 70 * DAY })).toBe(
      'Evidence was removed 90 days after this report was filed.',
    );
    expect(purgeNotice({ ...base, createdAt: filed, resolvedAt: filed + 95 * DAY })).toBe(
      'Evidence was removed 90 days after this report was filed.',
    );
    expect(purgeNotice({ ...base, createdAt: filed, resolvedAt: filed + 60 * DAY })).toBe(
      'Evidence was removed 30 days after this report was resolved.',
    );
  });
});

describe('worker answers', () => {
  test('Discord markup becomes names and times', () => {
    const names = new Map([[MEMBER, 'Riley']]);
    const seconds = Math.floor((NOW - 2 * HOUR) / 1000);

    expect(
      readableOutcome(
        `Report \`R1\` was already accepted by <@${MEMBER}> <t:${seconds}:R>.`,
        names,
        NOW,
      ),
    ).toBe('Report R1 was already accepted by @Riley 2h ago.');
    expect(readableOutcome('<@500000000000000009> in <#1>', names, NOW)).toBe(
      '@500000000000000009 in #channel',
    );
  });

  test('a worker timeout is a warning that the action may still land', () => {
    const failure = actionFailure(
      new Error(
        'The worker did not answer within 20 seconds. The action may still complete — refresh the report in a moment to see where it stands before trying again.',
      ),
      'The report was not accepted',
    );
    expect(failure.tone).toBe('warning');
    expect(failure.unsettled).toBe(true);
  });

  test('the api’s own sentences pass through, transport failures get Proton’s', () => {
    expect(actionFailure(new Error('Moderation is turned off in this server.'), 'x').message).toBe(
      'Moderation is turned off in this server.',
    );

    const unreachable = actionFailure(new Error('fetch failed'), 'The report was not claimed');
    expect(unreachable.tone).toBe('danger');
    expect(unreachable.message).toStartWith('The report was not claimed. ');
  });
});
