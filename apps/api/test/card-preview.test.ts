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

    expect(descriptor).toMatchObject({ accent: '#5865f2' });
  });

  test('draws the caller’s own avatar when one is passed, and none when it is not', () => {
    expect(previewDescriptor(parse({ kind: 'rank' }))).not.toHaveProperty('avatarUrl');
    expect(previewDescriptor(parse({ kind: 'rank', avatar: AVATAR_URL }))).toMatchObject({
      avatarUrl: AVATAR_URL,
    });
  });

  test('refuses an avatar that is not an https URL', () => {
    expect(cardPreviewQuerySchema.safeParse({ kind: 'rank', avatar: 'not a url' }).success).toBe(
      false,
    );
  });

  test('passes the element toggles through, so the preview shows what was disabled', () => {
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

  test('shows sample badges on a rank card only when asked', () => {
    const shown = previewDescriptor(parse({ kind: 'rank', showBadges: 'true' }));
    const plain = previewDescriptor(parse({ kind: 'rank' }));

    expect(shown).toMatchObject({ kind: 'rank', achievementCount: 7 });
    expect(shown.kind === 'rank' && shown.badges?.length).toBeGreaterThan(0);
    expect(plain).not.toHaveProperty('badges');
    expect(plain).not.toHaveProperty('achievementCount');
  });

  test('draws a badge in the colour asked for, as CSS hex', () => {
    const descriptor = previewDescriptor(
      parse({ kind: 'badge', shape: 'shield', icon: 'star', colour: String(0xd9a931) }),
    );

    expect(descriptor).toEqual({ kind: 'badge', shape: 'shield', colour: '#d9a931', icon: 'star' });
  });

  test('refuses a badge shape, icon or asset id it does not know', () => {
    expect(cardPreviewQuerySchema.safeParse({ kind: 'badge', shape: 'star' }).success).toBe(false);
    expect(cardPreviewQuerySchema.safeParse({ kind: 'badge', icon: 'skull' }).success).toBe(false);
    expect(cardPreviewQuerySchema.safeParse({ kind: 'badge', assetId: '../x' }).success).toBe(
      false,
    );
  });
});

describe('badge previews', () => {
  const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

  function capturing(badgeImage?: (guildId: string, assetId: string) => Promise<string | null>) {
    const rendered: unknown[] = [];
    const service = new CardPreviewService({
      render: async (input) => {
        rendered.push(input);
        return new Uint8Array(PNG_MAGIC);
      },
      ...(badgeImage ? { badgeImage } : {}),
    });
    return { service, rendered };
  }

  test('renders a real badge PNG through the route', async () => {
    const response = await get(
      appWith(new CardPreviewService()),
      'kind=badge&shape=hexagon&icon=rocket&colour=3001079',
    );

    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer()).slice(0, 4)]).toEqual(PNG_MAGIC);
  });

  test('asks for the uploaded image of the guild in the route', async () => {
    const asked: Array<[string, string]> = [];
    const { service, rendered } = capturing(async (guildId, assetId) => {
      asked.push([guildId, assetId]);
      return IMAGE;
    });

    const response = await get(appWith(service), 'kind=badge&assetId=a1b2c3d4e5');

    expect(response.status).toBe(200);
    expect(asked).toEqual([[GUILD, 'a1b2c3d4e5']]);
    expect(rendered).toEqual([
      { kind: 'badge', shape: 'circle', colour: '#2a8af7', icon: 'trophy', image: IMAGE },
    ]);
  });

  test('falls back to the icon when the asset is gone', async () => {
    const { service, rendered } = capturing(async () => null);

    await service.render(GUILD, parse({ kind: 'badge', icon: 'gift', assetId: 'a1b2c3d4e5' }));

    expect(rendered[0]).toEqual({
      kind: 'badge',
      shape: 'circle',
      colour: '#2a8af7',
      icon: 'gift',
    });
  });

  test('never asks for an image for a card that is not a badge', async () => {
    let asked = 0;
    const { service } = capturing(async () => {
      asked++;
      return IMAGE;
    });

    await service.render(GUILD, parse({ kind: 'rank', assetId: 'a1b2c3d4e5' }));

    expect(asked).toBe(0);
  });
});
