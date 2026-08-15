import { describe, expect, test } from 'bun:test';
import { caseQuerySchema } from '@proton/core';
import { z } from 'zod';

/**
 * The exact composition TanStack Start performs.
 *
 * `createServerFn.js` flattens middlewares and runs each validator in turn with
 * `ctx.data = await execValidator(validator, ctx.data)` — so every validator in
 * the chain *replaces* the payload for the ones after it. Reproduced here rather
 * than imported because the real chain needs a request context; what is being
 * asserted is the property of the schemas, which is where the bug lived.
 */
function chain(validators: readonly z.ZodType[], input: unknown): unknown {
  return validators.reduce<unknown>((data, validator) => validator.parse(data), input);
}

/** What `requireGuildAccess` declares. */
const guildAccessValidator = z.looseObject({ guildId: z.string().min(1) });

describe('server-function middleware validators', () => {
  /**
   * The bug that took out every module settings page.
   *
   * `requireGuildAccess` only cares about `guildId`, but a plain `z.object`
   * strips unknown keys, so it deleted `moduleId` before `getModuleConfig`'s own
   * validator ran — and the page died on "expected string, received undefined"
   * for a param that was right there in the URL.
   */
  test('a guild-scoped middleware passes through fields it does not read', () => {
    const getModuleConfig = z.object({
      guildId: z.string().min(1),
      moduleId: z.string().min(1),
    });

    expect(
      chain([guildAccessValidator, getModuleConfig], {
        guildId: '1450209710199279760',
        moduleId: 'cases',
      }),
    ).toEqual({ guildId: '1450209710199279760', moduleId: 'cases' });
  });

  /**
   * The quieter half of the same bug, and the reason this test exists at all.
   *
   * Every field of `caseQuerySchema` except `guildId` is optional or defaulted,
   * so a stripping middleware did not raise anything — the case table rendered
   * and simply ignored the moderator, the date range, the sort and the page.
   * A filter that silently does nothing is worse than one that errors.
   */
  test('case-search filters survive the middleware instead of being silently dropped', () => {
    const searchCases = caseQuerySchema.extend({ guildId: z.string().min(1) });

    const result = chain([guildAccessValidator, searchCases], {
      guildId: '1450209710199279760',
      type: 'ban',
      page: 3,
      sort: 'createdAt',
      direction: 'asc',
    }) as Record<string, unknown>;

    expect(result.type).toBe('ban');
    expect(result.page).toBe(3);
    expect(result.direction).toBe('asc');
  });

  test('the update mutation keeps its config payload', () => {
    const updateModuleConfig = z.object({
      guildId: z.string().min(1),
      moduleId: z.string().min(1),
      enabled: z.boolean().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    });

    expect(
      chain([guildAccessValidator, updateModuleConfig], {
        guildId: '1450209710199279760',
        moduleId: 'antinuke',
        enabled: true,
        config: { channelDeleteLimit: 3 },
      }),
    ).toEqual({
      guildId: '1450209710199279760',
      moduleId: 'antinuke',
      enabled: true,
      config: { channelDeleteLimit: 3 },
    });
  });

  /** It still has to *validate* — passing extra keys through is not the same as not checking. */
  test('the middleware still rejects a missing or empty guild id', () => {
    expect(() => guildAccessValidator.parse({ moduleId: 'cases' })).toThrow();
    expect(() => guildAccessValidator.parse({ guildId: '', moduleId: 'cases' })).toThrow();
  });

  /**
   * A plain `z.object` is the trap. Pinned so the next person who "tidies"
   * `looseObject` back to `object` sees why it cannot be.
   */
  test('a stripping object would delete the field, which is what broke the page', () => {
    const stripping = z.object({ guildId: z.string().min(1) });

    expect(stripping.parse({ guildId: 'g', moduleId: 'cases' })).toEqual({ guildId: 'g' });
  });
});
