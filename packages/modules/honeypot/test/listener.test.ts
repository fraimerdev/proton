import { describe, expect, test } from 'bun:test';
import type { ContainerChild } from '@proton/core';
import type { HoneypotLayout } from '../src/config.ts';
import { armed, DM_CHANNEL, type Harness, harness } from './harness.ts';

const TELLS = armed({ sendDirectMessage: true });

function layout(...children: ContainerChild[]): HoneypotLayout {
  return {
    mentions: { everyone: false, roles: false, users: false },
    embeds: [],
    components: [],
    v2: [{ kind: 'container', children }],
  };
}

function texts(nodes: readonly Record<string, unknown>[]): string[] {
  return nodes.flatMap((node) =>
    node.type === 10
      ? [String(node.content)]
      : texts(Array.isArray(node.components) ? (node.components as Record<string, unknown>[]) : []),
  );
}

function said(h: Harness): string {
  return texts((h.sentIn(DM_CHANNEL)[0]?.components ?? []) as Record<string, unknown>[]).join('\n');
}

function storedName(h: Harness, name: string | undefined): { asked: number } {
  const store = h.deps.guildState;
  if (!store) throw new Error('the harness has no server state');
  const port = { asked: 0 };

  h.deps.guildState = {
    ...store,
    get: async (guildId) => {
      const state = await store.get(guildId);
      return state !== null && name !== undefined ? { ...state, name } : state;
    },
  };
  h.deps.guildName = async () => {
    port.asked += 1;
    return 'Test Guild';
  };

  return port;
}

describe('the direct message a trap sends', () => {
  test('takes the server name from the details it already reads, without asking again', async () => {
    const h = harness();
    const port = storedName(h, 'Proton HQ');

    await h.trip({
      config: {
        ...TELLS,
        dmLayout: layout({ kind: 'text', content: 'Caught in {server}, {server.name}.' }),
      },
      tier: 'plus',
    });

    expect(said(h)).toContain('Caught in Proton HQ, Proton HQ.');
    expect(port.asked).toBe(0);
  });

  test('asks for the server name only when the stored details have none', async () => {
    const h = harness();
    const port = storedName(h, undefined);

    await h.trip({ config: TELLS });

    expect(said(h)).toContain('Test Guild');
    expect(port.asked).toBe(1);
  });
});
