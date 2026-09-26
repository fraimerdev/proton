export const GUILD = '900000000000000001';
export const OTHER_GUILD = '900000000000000002';
export const ADMIN = '100000000000000001';
export const MODERATOR = '100000000000000002';
export const REPORTER = '300000000000000001';
export const SECOND_REPORTER = '300000000000000002';
export const TARGET = '200000000000000001';
export const OTHER_TARGET = '200000000000000002';
export const CHANNEL = '500000000000000001';
export const REPORT_CHANNEL = '500000000000000002';
export const MESSAGE = '600000000000000001';
export const CARD_MESSAGE = '600000000000000002';

export const NOW = Date.parse('2026-09-18T12:00:00.000Z');

export const COMMENT = 'they keep posting a scam link in #general';
export const SNAPSHOT_TEXT = 'free nitro at totally-real.example';

export type Row = Record<string, unknown>;

export function iso(at: number): string {
  return new Date(at).toISOString();
}

export function reportRow(overrides: Row = {}): Row {
  return {
    id: 'Xk3P9aQ',
    guild_id: GUILD,
    number: 7,
    reporter_id: REPORTER,
    target_id: TARGET,
    method: 'message_menu',
    status: 'open',
    reason_id: 'scam',
    reason: 'Scam or suspicious link',
    custom_reason: null,
    comment: COMMENT,
    source_channel_id: CHANNEL,
    source_message_id: MESSAGE,
    source_author_id: TARGET,
    evidence: {
      message: {
        status: 'captured',
        snapshot: {
          id: MESSAGE,
          channelId: CHANNEL,
          authorId: TARGET,
          url: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
          content: SNAPSHOT_TEXT,
        },
      },
      links: [],
      attachments: [],
    },
    evidence_expires_at: iso(NOW + 90 * 86_400_000),
    evidence_purged_at: null,
    assignee_id: null,
    assigned_at: null,
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    reporter_note: null,
    action_kind: null,
    case_ids: [],
    card_channel_id: REPORT_CHANNEL,
    card_message_id: CARD_MESSAGE,
    evidence_message_id: null,
    card_state: 'posted',
    card_error: null,
    card_attempts: 1,
    card_version: 1,
    card_edit_attempts: 0,
    close_action: null,
    close_due_at: null,
    closed_at: null,
    close_attempts: 0,
    close_error: null,
    decision_token: null,
    decision_kind: null,
    decision_started_at: null,
    notifications: {},
    dm_channel_id: null,
    dm_attempts: 0,
    version: 1,
    idempotency_key: 'interaction:1400000000000000001',
    created_at: iso(NOW - 60 * 60_000),
    updated_at: iso(NOW - 30 * 60_000),
    ...overrides,
  };
}
