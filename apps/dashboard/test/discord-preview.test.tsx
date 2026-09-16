import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROTON_AVATAR } from '../src/components/discord/identity.tsx';
import { DiscordPreview } from '../src/components/discord/message-preview.tsx';

type PreviewProps = ComponentProps<typeof DiscordPreview>;

function render(props: Partial<PreviewProps> = {}): string {
  return renderToStaticMarkup(<DiscordPreview message={{ content: 'Pong!' }} {...props} />);
}

describe('the Discord message preview', () => {
  test('draws Proton with its own avatar and the verified App tag', () => {
    const markup = render();

    expect(markup).toContain(`<img class="dc-avatar" src="${PROTON_AVATAR}" alt=""/>`);
    expect(existsSync(join(import.meta.dir, '..', 'public', PROTON_AVATAR))).toBe(true);
    expect(markup).toMatch(
      /<span class="dc-bot-tag"><svg [^>]*aria-label="Verified"[^>]*>.*<\/svg>App<\/span>/,
    );
  });

  test('a slash command reply says who used which command, above the message', () => {
    const markup = render({ command: { user: 'solus', name: 'ping' } });

    expect(markup).toMatch(
      /<div class="dc-reference">.*<span class="dc-reference-user">solus<\/span>used<span class="dc-command">.*ping<\/span><\/div><div class="dc-message">/,
    );
  });

  test('a reply names the member replied to without an @, because Proton’s replies do not ping', () => {
    const markup = render({ replyTo: { user: 'Sam', text: '@Riley are you around?' } });

    expect(markup).toContain(
      '<span class="dc-reference-user">Sam</span><span class="dc-reference-text">@Riley are you around?</span>',
    );
  });

  test('an empty message draws no reference line', () => {
    const markup = render({ message: {}, command: { user: 'solus', name: 'ping' } });

    expect(markup).not.toContain('dc-reference');
    expect(markup).toContain('dc-empty');
  });
});
