import { describe, expect, test } from 'bun:test';
import { interactionReplyPayloadSchema } from '../../src/actions/payloads.ts';
import { EMBED_DESCRIPTION_MAX } from '../../src/messages/embed.ts';
import {
  errorStatus,
  isStatusBody,
  STATUS_ERROR_COLOUR,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_COLOUR,
  STATUS_SUCCESS_EMOJI,
  successStatus,
} from '../../src/messages/status.ts';

describe('status bodies', () => {
  test('a success carries the checkmark and green', () => {
    const body = successStatus('<@1> has been banned successfully!');

    expect(body.embeds).toEqual([
      {
        description: `${STATUS_SUCCESS_EMOJI} <@1> has been banned successfully!`,
        color: STATUS_SUCCESS_COLOUR,
      },
    ]);
  });

  test('an error carries the cross and red', () => {
    const body = errorStatus('I need the Ban Members permission to ban this member.');

    expect(body.embeds).toEqual([
      {
        description: `${STATUS_ERROR_EMOJI} I need the Ban Members permission to ban this member.`,
        color: STATUS_ERROR_COLOUR,
      },
    ]);
  });

  test('content is empty rather than absent, so an edit clears the text it replaces', () => {
    expect(successStatus('done').content).toBe('');
    expect(Object.keys(errorStatus('nope'))).toContain('content');
  });

  test('a description past the embed limit is cut, not refused', () => {
    const body = errorStatus('x'.repeat(EMBED_DESCRIPTION_MAX * 2));

    expect(body.embeds[0]?.description.length).toBe(EMBED_DESCRIPTION_MAX);
  });

  test('an empty content plus an embed still satisfies the reply payload', () => {
    const parsed = interactionReplyPayloadSchema.safeParse({
      interactionId: '900000000000000001',
      interactionToken: 'token',
      ...successStatus('It worked.'),
      ephemeral: true,
    });

    expect(parsed.success).toBe(true);
  });

  test('isStatusBody separates a status from plain text', () => {
    expect(isStatusBody(successStatus('yes'))).toBe(true);
    expect(isStatusBody('yes')).toBe(false);
    expect(isStatusBody(undefined)).toBe(false);
  });
});
