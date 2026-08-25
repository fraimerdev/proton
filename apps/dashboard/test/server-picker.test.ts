import { describe, expect, test } from 'bun:test';
import { guildIconUrl } from '../src/components/shell/app-shell.tsx';
import { botInviteUrl } from '../src/lib/invite.ts';

const INVITE = { clientId: '1200000000000000000', permissions: '1099511696390' };

describe('the invite url Proton hands Discord', () => {
  const url = new URL(botInviteUrl(INVITE, '900000000000000001'));

  test('is the oauth2 authorize endpoint, not the deprecated /api/oauth2 path', () => {
    expect(`${url.origin}${url.pathname}`).toBe('https://discord.com/oauth2/authorize');
  });

  test('asks for the commands scope as well as the bot one', () => {
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
  });

  test('carries the client id and the permission mask it was given, unmodified', () => {
    expect(url.searchParams.get('client_id')).toBe(INVITE.clientId);
    expect(url.searchParams.get('permissions')).toBe(INVITE.permissions);
  });

  // The card the admin clicked names one server. Leaving the picker enabled lets the flow finish
  // against a different one, and the dashboard then shows a server they did not ask to add.
  test('pins the guild the card was for, and locks the picker onto it', () => {
    expect(url.searchParams.get('guild_id')).toBe('900000000000000001');
    expect(url.searchParams.get('disable_guild_select')).toBe('true');
  });

  test('escapes the scope separator rather than sending a raw space', () => {
    expect(botInviteUrl(INVITE, '1')).toContain('scope=bot+applications.commands');
  });
});

describe('the icon a card draws', () => {
  const guild = { id: '900000000000000001', name: 'Pro’ Grammers', owner: true, permissions: '32' };

  test('asks Discord for a size the 72px crest does not have to upscale', () => {
    expect(guildIconUrl({ ...guild, icon: 'abc' }, 256)).toContain('size=256');
    expect(guildIconUrl({ ...guild, icon: 'abc' })).toContain('size=64');
  });

  // The card falls back to initials over the mark's gradient. Returning a CDN url for a server with
  // no icon would render Discord's 404 page into a 72px circle.
  test('is nothing at all when the server has no icon set', () => {
    expect(guildIconUrl({ ...guild, icon: null }, 256)).toBeNull();
  });
});
