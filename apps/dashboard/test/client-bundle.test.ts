import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');
const MODULES = join(import.meta.dir, '..', '..', '..', 'packages', 'modules');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.gen.ts')) out.push(full);
  }
  return out;
}

/** Module packages whose barrel drags discord.js in, and so cannot be imported bare. */
function barrelsCarryingDiscordJs(): string[] {
  return readdirSync(MODULES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const manifest = JSON.parse(
        readFileSync(join(MODULES, entry.name, 'package.json'), 'utf8'),
      ) as { name: string; dependencies?: Record<string, string> };
      return manifest.dependencies?.['discord.js'] !== undefined;
    })
    .map(
      (entry) =>
        (
          JSON.parse(readFileSync(join(MODULES, entry.name, 'package.json'), 'utf8')) as {
            name: string;
          }
        ).name,
    );
}

/**
 * discord.js lazily imports `zlib-sync`, a native Node addon. Vite cannot resolve it for the
 * browser, so a bare barrel import fails the dev server outright — and would ship a gateway
 * library to the client, which I6 forbids. Subpath imports like `/config` stay clean.
 */
describe('dashboard client bundle', () => {
  const tainted = barrelsCarryingDiscordJs();

  test('some module barrels really do carry discord.js, or this test proves nothing', () => {
    expect(tainted.length).toBeGreaterThan(0);
  });

  test('no dashboard source imports one of those barrels bare', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const pkg of tainted) {
        if (new RegExp(`from '${pkg}'`).test(source)) {
          offenders.push(`${file.replace(SRC, 'src')} imports ${pkg} — use a subpath export`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
