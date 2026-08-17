import { describe, expect, test } from 'bun:test';
import { automodConfigSchema } from '@proton/module-automod/config';
import { renderToStaticMarkup } from 'react-dom/server';
import { EnforcementPanel } from '../src/components/automod/enforcement.tsx';

function render(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <EnforcementPanel config={automodConfigSchema.parse({ enabled: true, ...overrides })} />,
  );
}

describe('EnforcementPanel', () => {
  test('an empty config says so rather than showing an empty list', () => {
    expect(render()).toContain('Nothing yet');
  });

  test('blocked words show as enforced by Discord', () => {
    expect(render({ blockedWords: ['scam'] })).toContain('Blocked words and patterns');
  });

  test('a pattern Discord cannot run is named, with the reason', () => {
    const html = render({ regexPatterns: ['scam(?!proof)'] });

    expect(html).toContain('Proton runs these itself');
    expect(html).toContain('lookahead');
  });

  test('a translatable pattern is not listed as in-house', () => {
    expect(render({ regexPatterns: ['free\\s+nitro'] })).not.toContain('Proton runs these itself');
  });

  test('the panel promises not to touch hand-made rules', () => {
    expect(render({ nativeSpam: true })).toContain('never edited or removed');
  });
});
