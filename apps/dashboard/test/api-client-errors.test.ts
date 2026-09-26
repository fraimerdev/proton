import { afterEach, describe, expect, test } from 'bun:test';
import { ApiClient, ApiError } from '../src/lib/api-client.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: string) {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
}

const CLAIMS = {
  purpose: 'appeal' as const,
  guildId: '900000000000000002',
  userId: '400000000000000001',
  panelId: 'default',
  origin: 'ban',
  issuedAt: 1,
  expiresAt: 2,
  jti: 'abc123',
};

async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the api client to throw');
}

describe('ApiClient refusals', () => {
  // Without the code, a member whose server was gone was told they were verified and to retry.
  test('carry the api error code and message', async () => {
    answer(
      409,
      JSON.stringify({ error: 'guild_left', message: 'Proton is no longer in this server.' }),
    );
    const api = new ApiClient('http://api.test', 'secret');

    const error = await refusal(() =>
      api.recordVerificationPass(CLAIMS.guildId, { userId: CLAIMS.userId, jti: 'abc123' }),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('guild_left');
    expect(error.message).toBe('Proton is no longer in this server.');
  });

  test('are still plain Errors to every caller that only reads the message', async () => {
    answer(409, JSON.stringify({ error: 'guild_left', message: 'gone' }));

    const error = await refusal(() =>
      new ApiClient('http://api.test', 'secret').getAppealForm(CLAIMS),
    );

    expect(error).toBeInstanceOf(Error);
  });

  test('an answer that is not JSON has no code and the neutral outage wording', async () => {
    answer(502, '<html>bad gateway</html>');

    const error = await refusal(() =>
      new ApiClient('http://api.test', 'secret').submitAppeal(CLAIMS, {}),
    );

    expect(error.code).toBeUndefined();
    expect(error.status).toBe(502);
    expect(error.message).toContain("Proton's API did not answer (HTTP 502)");
  });
});
