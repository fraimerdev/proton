import { describe, expect, test } from 'bun:test';

const ROOT = `${import.meta.dir}/../../..`;

async function readJson<T>(path: string): Promise<T> {
  return (await Bun.file(path).json()) as T;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Gate 0: "restarting the worker does not cause a gateway identify."
 *
 * Proven structurally rather than by counting opcodes against a live gateway.
 * The worker has no gateway client at all — no `@discordjs/ws`, no
 * `WebSocketManager`, no IDENTIFY payload anywhere in its dependency closure —
 * so a restart *cannot* identify. That is a stronger guarantee than observing
 * zero identifies during one run, which would only show it did not happen to.
 *
 * The complementary half (a gateway restart RESUMEs rather than identifies) is
 * covered by apps/gateway/test/session-store.integration.test.ts.
 */
describe('worker deploys cannot consume session starts (I13)', () => {
  test('the worker does not depend on any gateway client', async () => {
    const pkg = await readJson<PackageJson>(`${ROOT}/apps/worker/package.json`);
    const runtimeDeps = Object.keys(pkg.dependencies ?? {});

    // @discordjs/ws is the only thing in the tree that can open a gateway
    // connection, and discord.js's Client owns one implicitly.
    expect(runtimeDeps).not.toContain('@discordjs/ws');
    expect(runtimeDeps).not.toContain('discord.js');
  });

  test('only the gateway app depends on @discordjs/ws', async () => {
    const gateway = await readJson<PackageJson>(`${ROOT}/apps/gateway/package.json`);

    expect(Object.keys(gateway.dependencies ?? {})).toContain('@discordjs/ws');

    for (const app of ['api', 'rest-proxy', 'worker']) {
      const pkg = await readJson<PackageJson>(`${ROOT}/apps/${app}/package.json`);
      expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@discordjs/ws');
    }
  });

  test('no worker source file constructs a gateway connection', async () => {
    const glob = new Bun.Glob('src/**/*.ts');
    const offenders: string[] = [];

    for await (const file of glob.scan({ cwd: `${ROOT}/apps/worker` })) {
      const source = await Bun.file(`${ROOT}/apps/worker/${file}`).text();
      if (/WebSocketManager|new\s+Client\s*\(/.test(source)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  /**
   * I2's counterpart: no process other than the proxy may hold a REST client
   * against discord.com. A stray one would also mean a second rate-limit budget.
   */
  test('only the rest-proxy and gateway depend on @discordjs/rest', async () => {
    for (const app of ['api', 'worker', 'dashboard']) {
      const pkg = await readJson<PackageJson>(`${ROOT}/apps/${app}/package.json`);
      expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@discordjs/rest');
    }
  });
});
