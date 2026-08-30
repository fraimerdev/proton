import { describe, expect, test } from 'bun:test';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import {
  CardPreviewService,
  cardPreviewQuerySchema,
  previewDescriptor,
} from '../src/cards/preview.ts';

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';
const AVATAR_URL = `https://cdn.discordapp.com/avatars/100000000000000001/${'a'.repeat(32)}.png`;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function appWith(cards: CardPreviewService) {
  return createApiApp({ cards, sharedSecret: SECRET } as unknown as ApiDeps);
}

function get(app: ReturnType<typeof createApiApp>, query: string, secret: string | null = SECRET) {
  return app.request(`/guilds/${GUILD}/cards/preview?${query}`, {
    headers: secret === null ? {} : { 'x-proton-secret': secret },
  });
}

function parse(query: Record<string, string>) {
  const parsed = cardPreviewQuerySchema.safeParse(query);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

describe('GET /guilds/:guildId/cards/preview', () => {
  test('renders the real card as a PNG', async () => {
    const response = await get(appWith(new CardPreviewService()), 'kind=rank&preset=midnight');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await response.arrayBuffer()).slice(0, 4)]).toEqual(PNG_MAGIC);
  });

  // A preview is regenerated on every keystroke of a colour picker; a cached one would show the
  // previous value and read as the setting not working.
  test('is never cached', async () => {
    const response = await get(appWith(new CardPreviewService()), 'kind=welcome');

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('needs the shared secret, like every other guild route', async () => {
    const response = await get(appWith(new CardPreviewService()), 'kind=rank', null);

    expect(response.status).toBe(401);
  });

  test('names the offending parameter rather than rendering something wrong', async () => {
    const response = await get(appWith(new CardPreviewService()), 'kind=trophy');

    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain('kind');
  });

  test('a render failure answers 400 rather than a broken image', async () => {
    const service = new CardPreviewService({
      render: async () => {
        throw new Error('the rasteriser exploded');
      },
    });

    const response = await get(appWith(service), 'kind=rank');

    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain(
      'the rasteriser exploded',
    );
  });
});

describe('previewDescriptor', () => {
  test('carries the guild’s accent through as CSS hex', () => {
    const descriptor = previewDescriptor(parse({ kind: 'rank', accent: String(0x5865f2) }));

    expect(descriptor.accent).toBe('#5865f2');
  });

  test('draws the caller’s own avatar when one is passed, and none when it is not', () => {
    expect(previewDescriptor(parse({ kind: 'rank' })).avatarUrl).toBeUndefined();
    expect(previewDescriptor(parse({ kind: 'rank', avatar: AVATAR_URL })).avatarUrl).toBe(
      AVATAR_URL,
    );
  });

  test('refuses an avatar that is not an https URL', () => {
    expect(cardPreviewQuerySchema.safeParse({ kind: 'rank', avatar: 'not a url' }).success).toBe(
      false,
    );
  });

  test('passes the element toggles through, so the preview shows what was switched off', () => {
    const descriptor = previewDescriptor(
      parse({ kind: 'rank', showRank: 'false', showPercent: 'true' }),
    );

    expect(descriptor).toMatchObject({ showRank: false, showPercent: true });
  });

  test('leaves a toggle the caller omitted to the descriptor default', () => {
    expect(previewDescriptor(parse({ kind: 'rank' }))).not.toHaveProperty('showRank');
  });

  test('fills a greeting with sample data the viewer will recognise as sample', () => {
    const descriptor = previewDescriptor(parse({ kind: 'welcome', displayName: 'Fraimer' }));

    expect(descriptor).toMatchObject({
      kind: 'welcome',
      displayName: 'Fraimer',
      guildName: 'Your server',
    });
  });

  test('refuses a background that is not an https URL', () => {
    expect(
      cardPreviewQuerySchema.safeParse({ kind: 'rank', background: 'http://example.com/a.png' })
        .success,
    ).toBe(false);
  });
});
