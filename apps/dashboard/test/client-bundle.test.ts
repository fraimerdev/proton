import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

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

const WORKSPACE = join(import.meta.dir, '..', '..', '..', 'packages');

/**
 * Packages carrying a native addon. Vite's dependency optimizer tries to parse the `.node`
 * binary as UTF-8 and fails the dev server with an error that names the binary, not the import
 * that reached it — so the reachability is worth asserting here rather than rediscovering.
 */
const NATIVE_DEPS = ['@napi-rs/canvas', 'zlib-sync', 'bufferutil', 'utf-8-validate'];

interface PackageManifest {
  name: string;
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function workspaceManifests(): Map<string, { dir: string; manifest: PackageManifest }> {
  const found = new Map<string, { dir: string; manifest: PackageManifest }>();

  const roots = [WORKSPACE, MODULES];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      try {
        const manifest = JSON.parse(
          readFileSync(join(dir, 'package.json'), 'utf8'),
        ) as PackageManifest;
        found.set(manifest.name, { dir, manifest });
      } catch {
        // not a package directory
      }
    }
  }

  return found;
}

function carriesNative(name: string, packages: ReturnType<typeof workspaceManifests>): boolean {
  const entry = packages.get(name);
  if (!entry) return NATIVE_DEPS.includes(name);

  return Object.keys(entry.manifest.dependencies ?? {}).some((dep) => carriesNative(dep, packages));
}

function resolveSpecifier(
  specifier: string,
  packages: ReturnType<typeof workspaceManifests>,
): string | null {
  for (const [name, { dir, manifest }] of packages) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;

    const subpath = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`;
    const target = manifest.exports?.[subpath];

    return target ? join(dir, target) : null;
  }

  return null;
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** Every workspace file the dashboard's own sources can reach, following package exports. */
function reachableFromDashboard(
  packages: ReturnType<typeof workspaceManifests>,
  roots: string[] = sourceFiles(SRC),
): {
  files: Set<string>;
  edges: Map<string, string>;
} {
  const files = new Set<string>();
  const edges = new Map<string, string>();
  const queue: Array<{ file: string; from: string }> = [];

  for (const file of roots) {
    for (const specifier of importsOf(file)) {
      const resolved = resolveSpecifier(specifier, packages);
      if (resolved)
        queue.push({ file: resolved, from: `${file.replace(SRC, 'src')} → ${specifier}` });
    }
  }

  while (queue.length > 0) {
    const next = queue.pop();
    if (!next || files.has(next.file)) continue;

    files.add(next.file);
    edges.set(next.file, next.from);

    let nested: string[];
    try {
      nested = importsOf(next.file);
    } catch {
      continue;
    }

    for (const specifier of nested) {
      if (specifier.startsWith('.')) {
        const relative = join(next.file, '..', specifier);
        if (!files.has(relative)) queue.push({ file: relative, from: next.from });
        continue;
      }

      const resolved = resolveSpecifier(specifier, packages);
      if (resolved && !files.has(resolved)) {
        queue.push({ file: resolved, from: `${next.from} → ${specifier}` });
      }
    }
  }

  return { files, edges };
}

describe('native addons stay out of the dashboard', () => {
  const packages = workspaceManifests();

  test('some workspace package really does carry a native addon, or this proves nothing', () => {
    expect([...packages.keys()].some((name) => carriesNative(name, packages))).toBe(true);
  });

  test('@proton/cards exposes its presets without its canvas', () => {
    const cards = packages.get('@proton/cards');

    expect(cards?.manifest.exports?.['./presets']).toBe('./src/presets.ts');
    expect(importsOf(join(cards?.dir ?? '', 'src', 'presets.ts'))).toEqual([]);
  });

  test('no file the dashboard can reach imports a package carrying a native addon', () => {
    const { files, edges } = reachableFromDashboard(packages);
    const offenders: string[] = [];

    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('.')) continue;
        if (!carriesNative(specifier, packages)) continue;

        offenders.push(`${edges.get(file) ?? file} → ${specifier} (carries a native addon)`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * Packages that belong to the server half of the dashboard. They carry no native addon, so the
 * guard above waves them through — which is how two constants imported from a module barrel put
 * drizzle-orm in the browser bundle unnoticed.
 */
const SERVER_ONLY = ['drizzle-orm', '@proton/db', 'better-auth', '@better-auth/drizzle-adapter'];

/**
 * TanStack Start swaps a server function's body for an RPC stub in the client build, so a route
 * component may import src/server freely. Nothing reached from the far side of that boundary is
 * shipped — but everything reached from a plain component is.
 */
function serverHalf(file: string): boolean {
  const path = file.split(sep).join('/');

  return (
    /\/src\/(server|middleware)\//.test(path) ||
    /\/src\/lib\/(auth|db|discord-token|env)\.ts$/.test(path)
  );
}

describe('the server half of the dashboard stays on the server', () => {
  const packages = workspaceManifests();

  test('the boundary matches the files it is meant to, or the roots below prove nothing', () => {
    const server = sourceFiles(SRC)
      .filter(serverHalf)
      .map((file) => file.replace(SRC, 'src').split(sep).join('/'))
      .sort();

    expect(server).toEqual([
      'src/lib/auth.ts',
      'src/lib/db.ts',
      'src/lib/discord-token.ts',
      'src/lib/env.ts',
      'src/middleware/guild-access.ts',
      'src/server/audit.ts',
      'src/server/honeypot.ts',
      'src/server/modules.ts',
      'src/server/verification.ts',
    ]);
  });

  test('no component reaches a package that only makes sense on the server', () => {
    const roots = sourceFiles(SRC).filter((file) => !serverHalf(file));
    const { files, edges } = reachableFromDashboard(packages, roots);
    const offenders: string[] = [];

    for (const file of files) {
      for (const specifier of importsOf(file)) {
        const owner = SERVER_ONLY.find(
          (name) => specifier === name || specifier.startsWith(`${name}/`),
        );
        if (!owner) continue;

        offenders.push(`${edges.get(file) ?? file} -> ${specifier} (server only)`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
