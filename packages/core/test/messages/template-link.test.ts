import { describe, expect, test } from 'bun:test';
import { messageObjectSchema } from '../../src/messages/message.ts';
import {
  holdsPlaceholder,
  isLinkOrTemplate,
  isLiteralLink,
} from '../../src/messages/template-link.ts';
import { placeholderLinkPaths } from '../../src/placeholders/message-fields.ts';

describe('links that a placeholder fills in', () => {
  test('accept a complete link or a placeholder, and nothing else', () => {
    expect(isLinkOrTemplate('https://cdn.discordapp.com/embed/avatars/0.png')).toBe(true);
    expect(isLinkOrTemplate('{user.avatar_url}')).toBe(true);
    expect(isLinkOrTemplate('https://example.com/u/{user.id}')).toBe(true);
    expect(isLinkOrTemplate('avatar.png')).toBe(false);
    expect(isLinkOrTemplate('ftp://files.example')).toBe(false);
  });

  test('never count escaped braces as a placeholder', () => {
    expect(holdsPlaceholder('{{user.avatar_url}}')).toBe(false);
    expect(isLinkOrTemplate('{{user.avatar_url}}')).toBe(false);
    expect(isLiteralLink('{user.avatar_url}')).toBe(false);
  });

  test('let a stored message keep a placeholder in every kind of link', () => {
    const parsed = messageObjectSchema.safeParse({
      embeds: [
        {
          title: 'Hi',
          url: '{server.icon_url}',
          thumbnailUrl: '{user.avatar_url}',
          imageUrl: '{server.banner_url}',
          author: { name: 'x', iconUrl: '{user.avatar_url}' },
          footer: { text: 'y', iconUrl: '{server.icon_url}' },
        },
      ],
    });

    expect(parsed.success).toBe(true);
    expect(
      messageObjectSchema.safeParse({ embeds: [{ thumbnailUrl: 'avatar.png' }] }).success,
    ).toBe(false);
  });

  test('find every link that holds a placeholder', () => {
    const paths = placeholderLinkPaths({
      embeds: [{ thumbnailUrl: '{user.avatar_url}', imageUrl: 'https://example.com/a.png' }],
    });

    expect(paths).toEqual([['embeds', '0', 'thumbnailUrl']]);
    expect(placeholderLinkPaths({ embeds: [{ thumbnailUrl: 'https://a.example' }] })).toEqual([]);
  });

  test('leave alone a complete link that merely contains braces, as it always passed', () => {
    expect(
      placeholderLinkPaths({ embeds: [{ thumbnailUrl: 'https://example.com/{id}.png' }] }),
    ).toEqual([]);
  });
});
