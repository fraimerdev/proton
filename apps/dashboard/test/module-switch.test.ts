import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  configurableDescriptors,
  MODULE_SWITCH_PATH,
} from '../src/components/shell/module-meta.ts';

const SRC = join(import.meta.dir, '..', 'src');

function field(path: string) {
  return { path, kind: 'boolean', label: path, optional: false };
}

describe('the module switch is not also a form field', () => {
  test('the switch path is dropped, and nothing else is', () => {
    const kept = configurableDescriptors([
      field(MODULE_SWITCH_PATH),
      field('welcomeChannelId'),
      field('welcomeMessage'),
    ]);

    expect(kept.map((d) => d.path)).toEqual(['welcomeChannelId', 'welcomeMessage']);
  });

  // A nested field that merely ends in the same word is a different setting — announcements has
  // per-announcement `enabled` flags, and dropping those would hide real configuration.
  test('a nested field whose leaf is also called enabled survives', () => {
    const kept = configurableDescriptors([field(MODULE_SWITCH_PATH), field('saved.enabled')]);

    expect(kept.map((d) => d.path)).toEqual(['saved.enabled']);
  });

  test('the settings form and the command palette filter through the same helper', () => {
    const page = readFileSync(
      join(SRC, 'routes', 'dashboard', '$guildId', '$moduleId.tsx'),
      'utf8',
    );
    const shell = readFileSync(join(SRC, 'components', 'shell', 'app-shell.tsx'), 'utf8');

    // Different arguments now: the form filters the descriptors it fetched for its one module,
    // the palette filters the path-and-label pairs the module index carries for all of them.
    expect(page).toContain('configurableDescriptors(declared)');
    expect(shell).toContain('configurableDescriptors(module.fields)');
  });

  // Every module config carries its own `enabled` alongside the guild_modules row, and the worker
  // reads either being false as off. With the field hidden, the module page's master switch is the
  // only way to set it — so the write has to carry both or a switched-on module would sit dead on a
  // stored config saying otherwise.
  test('the API mirrors the switch into the stored config', () => {
    const service = readFileSync(
      join(SRC, '..', '..', 'api', 'src', 'modules', 'service.ts'),
      'utf8',
    );

    expect(service).toContain('enabled: input.enabled');
    expect(service).not.toContain('const nextConfigRaw = input.config ?? before.config;');
  });
});
