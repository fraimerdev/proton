import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  moduleScheduleKey,
  scheduledActionPayloadSchema,
} from '../../src/actions/scheduled-actions.ts';

const GUILD = '900000000000000001';

const segment = fc.string({
  unit: fc.constantFrom('a', 'Z', '0', '-', '_', ':', '\\', 'é', '😀'),
  maxLength: 6,
});

const quad = fc.tuple(segment, segment, segment, segment);

describe('moduleScheduleKey', () => {
  test('joins the module, the job, the guild and the natural key', () => {
    expect(moduleScheduleKey('reminders', 'remind', GUILD, 'reminder-42')).toBe(
      `reminders:remind:${GUILD}:reminder-42`,
    );
  });

  test('a natural key carrying a separator cannot collide with a different job id', () => {
    expect(moduleScheduleKey('tags', 'a', GUILD, 'b:c')).not.toBe(
      moduleScheduleKey('tags', 'a:b', GUILD, 'c'),
    );
  });

  test('a natural key that is itself an escape sequence stays its own key', () => {
    expect(moduleScheduleKey('tags', 'post', GUILD, '\\:')).not.toBe(
      moduleScheduleKey('tags', 'post', GUILD, ':'),
    );
  });

  test('two distinct module, job, guild and natural key tuples never share a key', () => {
    fc.assert(
      fc.property(quad, quad, (a, b) => {
        if (moduleScheduleKey(...a) !== moduleScheduleKey(...b)) return;

        expect(a).toEqual(b);
      }),
    );
  });
});

describe('scheduledActionPayloadSchema', () => {
  test('a reversal row written before the discriminator existed still parses as a reversal', () => {
    const parsed = scheduledActionPayloadSchema.safeParse({
      caseId: 'case-1',
      moduleId: 'moderation',
      actorId: '100000000000000000',
      targetId: '400000000000000000',
      originalKind: 'ban',
      action: { userId: '400000000000000000' },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ kind: 'reversal', caseId: 'case-1' });
  });

  test('a module payload is not mistaken for a legacy reversal', () => {
    const parsed = scheduledActionPayloadSchema.safeParse({
      kind: 'module',
      moduleId: 'reminders',
      jobId: 'remind',
      guildId: GUILD,
      data: { text: 'stand up' },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ kind: 'module', jobId: 'remind' });
  });

  test('a payload with no kind and no reversal fields is refused, and names the field', () => {
    const parsed = scheduledActionPayloadSchema.safeParse({ nothing: true });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.map(String).join('.'))).toContain('caseId');
  });

  test('a payload naming a kind neither arm knows is refused', () => {
    expect(scheduledActionPayloadSchema.safeParse({ kind: 'wat' }).success).toBe(false);
  });
});
