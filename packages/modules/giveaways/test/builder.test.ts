import { describe, expect, test } from 'bun:test';
import { CORE_PROVIDER_IDS, ProviderRegistry, protonFields, zodToDescriptors } from '@proton/core';
import { ComponentType, TextInputStyle } from 'discord-api-types/v10';
import { z } from 'zod';
import {
  builderRouteOf,
  handleBuilderComponent,
  handleBuilderModal,
} from '../src/builder/handler.ts';
import { descriptorsToModal, readDescriptorValues } from '../src/builder/modal.ts';
import {
  BASICS_MODAL,
  BUILDER_ADD_REQUIREMENT,
  BUILDER_CANCEL,
  BUILDER_LOGIC,
  BUILDER_REMOVE,
  ITEM_MODAL,
} from '../src/builder/screens.ts';
import { type DraftStore, draftKey, emptyDraft, MemoryDraftStore } from '../src/builder/state.ts';
import { BUILDER_EDIT_STEP, stepScreen } from '../src/builder/steps.ts';
import { createGiveawayProviders } from '../src/providers.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

const GUILD = '100000000000000000';
const CHANNEL = '500000000000000000';
const HOST = '400000000000000001';
const ROLE = '600000000000000000';
const NOW = 1_776_000_000_000;

function registry(): ProviderRegistry {
  const providers = new ProviderRegistry();
  providers.register({
    id: 'giveaways',
    providers: createGiveawayProviders(new MemoryGiveawayStore()),
  });
  return providers;
}

const availability = {
  async isEnabled() {
    return true;
  },
};

async function seeded(drafts: DraftStore = new MemoryDraftStore()) {
  const draft = emptyDraft(GUILD, CHANNEL, HOST, { winnerCount: 1 }, NOW);
  await drafts.put(draftKey(GUILD, HOST), draft);

  return {
    drafts,
    deps: {
      store: new MemoryGiveawayStore(),
      providers: registry(),
      drafts,
      availability,
      now: () => NOW,
    },
  };
}

function flatten(components: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const flat: Record<string, unknown>[] = [];

  for (const component of components) {
    flat.push(component);
    const nested = component.components;
    if (Array.isArray(nested)) flat.push(...flatten(nested as Record<string, unknown>[]));
    const wrapped = component.component;
    if (wrapped) flat.push(wrapped as Record<string, unknown>);
  }

  return flat;
}

describe('descriptor to modal', () => {
  test('every core provider builder renders as a valid modal', () => {
    const providers = new ProviderRegistry();

    for (const id of CORE_PROVIDER_IDS) {
      const provider = providers.condition(id);
      if (!provider || provider.builder.length === 0) continue;

      const modal = descriptorsToModal('proton:giveaways:x', provider.label, provider.builder);
      expect(`${id}: ${modal.ok}`).toBe(`${id}: true`);

      if (!modal.ok) continue;
      expect(modal.modal.components.length).toBeGreaterThan(0);
      expect(modal.modal.components.length).toBeLessThanOrEqual(5);

      for (const component of modal.modal.components) {
        expect(component.type).toBe(ComponentType.Label);
      }
    }
  });

  // There is no numeric modal component, so a number is a Short text input parsed on submit.
  test('a number field becomes a short text input with a range hint', () => {
    const schema = z.object({ min: z.number().int().min(1).max(99).default(5) });
    const modal = descriptorsToModal('x', 'Level', zodToDescriptors(schema));

    if (!modal.ok) throw new Error(modal.humanReason);

    const input = flatten(modal.modal.components).find(
      (component) => component.type === ComponentType.TextInput,
    );

    expect(input?.style).toBe(TextInputStyle.Short);
    expect(String(input?.placeholder)).toContain('between 1 and 99');
  });

  test('a role-id array becomes a multi-select role picker', () => {
    const provider = new ProviderRegistry().condition('core.has_role');
    if (!provider) throw new Error('core.has_role missing');

    const modal = descriptorsToModal('x', 'Roles', provider.builder);
    if (!modal.ok) throw new Error(modal.humanReason);

    const select = flatten(modal.modal.components).find(
      (component) => component.type === ComponentType.RoleSelect,
    );

    expect(select).toBeDefined();
    expect(Number(select?.max_values)).toBeGreaterThan(1);
  });

  test('an enum becomes a string select with its options', () => {
    const schema = z.object({ window: z.enum(['lifetime', '7d', '30d']).default('30d') });
    const modal = descriptorsToModal('x', 'Window', zodToDescriptors(schema));

    if (!modal.ok) throw new Error(modal.humanReason);

    const select = flatten(modal.modal.components).find(
      (component) => component.type === ComponentType.StringSelect,
    );

    const options = (select?.options ?? []) as { value: string }[];
    expect(options.map((option) => option.value)).toEqual(['lifetime', '7d', '30d']);
  });

  test('a builder wider than one modal is refused with a reason, not truncated', () => {
    const shape: Record<string, z.ZodType> = {};
    for (let index = 0; index < 6; index += 1) shape[`f${index}`] = z.string().default('');

    const modal = descriptorsToModal('x', 'Too wide', zodToDescriptors(z.object(shape)));

    expect(modal.ok).toBe(false);
    if (!modal.ok) expect(modal.humanReason).toContain('at most 5');
  });
});

describe('reading a submitted modal', () => {
  const schema = z.object({
    min: z.number().int().min(1).max(99).default(5),
    window: z.enum(['lifetime', '30d']).default('30d'),
  });
  const descriptors = zodToDescriptors(schema);

  test('parses a number and a select into config', () => {
    const read = readDescriptorValues(descriptors, { min: '7' }, { window: ['lifetime'] });

    expect(read.ok).toBe(true);
    if (read.ok) expect(read.config).toEqual({ min: 7, window: 'lifetime' });
  });

  test('a non-numeric answer is refused by name, not coerced to NaN', () => {
    const read = readDescriptorValues(descriptors, { min: 'five' }, { window: ['30d'] });

    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.humanReason).toContain('is not a number');
  });

  // Discord cannot enforce a numeric range on a text input, so the range check has to live here.
  test('a number outside its range is refused with the bound named', () => {
    const read = readDescriptorValues(descriptors, { min: '500' }, { window: ['30d'] });

    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.humanReason).toContain('at most 99');
  });

  test('an unreadable duration is refused with an example', () => {
    const durations = zodToDescriptors(
      z.object({
        d: z.string().register(protonFields, { field: 'duration', label: 'How long' }),
      }),
    );

    const read = readDescriptorValues(durations, { d: 'a fortnight' }, {});

    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.humanReason).toContain('30m');
  });

  test('a role select comes back as an array when the field is an array', () => {
    const provider = new ProviderRegistry().condition('core.has_role');
    if (!provider) throw new Error('missing');

    const read = readDescriptorValues(
      provider.builder,
      {},
      { roleIds: [ROLE, '600000000000000001'], mode: ['all'] },
    );

    expect(read.ok).toBe(true);
    if (read.ok) expect(read.config.roleIds).toEqual([ROLE, '600000000000000001']);
  });
});

describe('the builder screen', () => {
  test('offers a picker per kind and refuses to start without a prize', async () => {
    const { deps } = await seeded();
    const draft = emptyDraft(GUILD, CHANNEL, HOST, { winnerCount: 1 }, NOW);

    const available = await deps.providers.listAvailable(GUILD, availability);
    const screen = stepScreen(draft, deps.providers, available);

    if (!screen.ok) throw new Error(screen.humanReason);

    const buttons = flatten(screen.components).filter(
      (component) => component.type === ComponentType.Button,
    );
    const start = buttons.find((button) => String(button.label).includes('Publish'));

    expect(start?.disabled).toBe(true);
    expect(screen.content).toContain('not set yet');
  });

  test('enables start once a prize is set', async () => {
    const { deps } = await seeded();
    const draft = { ...emptyDraft(GUILD, CHANNEL, HOST, { winnerCount: 1 }, NOW), title: 'Nitro' };

    const available = await deps.providers.listAvailable(GUILD, availability);
    const screen = stepScreen(draft, deps.providers, available);

    if (!screen.ok) throw new Error(screen.humanReason);

    const start = flatten(screen.components)
      .filter((component) => component.type === ComponentType.Button)
      .find((button) => String(button.label).includes('Publish'));

    expect(start?.disabled).toBe(false);
  });

  test('a guild with no provider modules on still gets a usable, explained picker', async () => {
    const providers = new ProviderRegistry();
    // The pickers live on their own steps now, so the disabled-but-explained case is on 'bonus'.
    const draft = {
      ...emptyDraft(GUILD, CHANNEL, HOST, { winnerCount: 1 }, NOW),
      step: 'bonus' as const,
    };

    const available = await providers.listAvailable(GUILD, {
      async isEnabled() {
        return false;
      },
    });

    const screen = stepScreen(draft, providers, available);
    if (!screen.ok) throw new Error(screen.humanReason);

    const selects = flatten(screen.components).filter(
      (component) => component.type === ComponentType.StringSelect,
    );

    // Core conditions are always there, so the requirement picker is live; the multiplier one is
    // the disabled-but-explained case.
    const disabled = selects.find((select) => select.disabled === true);
    expect(String(disabled?.placeholder)).toContain('No bonus-entry rules');

    // Discord rejects a select with no options, so even the disabled one has to carry a filler.
    const filler = (disabled?.options ?? []) as unknown[];
    expect(filler.length).toBeGreaterThan(0);
  });
});

describe('builder routing', () => {
  test('a builder custom id round-trips its action and args', () => {
    const provider = new ProviderRegistry().condition('core.has_role');
    if (!provider) throw new Error('missing');

    const draft = emptyDraft(GUILD, CHANNEL, HOST, { winnerCount: 1 }, NOW);
    const screen = stepScreen(draft, new ProviderRegistry(), []);
    if (!screen.ok) throw new Error(screen.humanReason);

    const button = flatten(screen.components).find(
      (component) => component.type === ComponentType.Button,
    );

    const route = builderRouteOf(String(button?.custom_id));

    // 'b:edit' carries the step it opens as an arg, which is the round trip that matters: the
    // action segment has its own colon and has to survive escaping intact.
    expect(route?.action).toBe(BUILDER_EDIT_STEP);
    expect(route?.args).toEqual(['basics']);
  });

  test('a custom id from another module is not ours', () => {
    expect(builderRouteOf('proton:tickets:open:1')).toBeNull();
    expect(builderRouteOf('nonsense')).toBeNull();
  });
});

describe('builder interactions', () => {
  test('picking a requirement with settings opens its modal', async () => {
    const { deps } = await seeded();

    const reply = await handleBuilderComponent(deps, {
      action: BUILDER_ADD_REQUIREMENT,
      args: [],
      guildId: GUILD,
      channelId: CHANNEL,
      userId: HOST,
      values: ['core.has_role'],
    });

    expect(reply.kind).toBe('modal');
    if (reply.kind === 'modal') {
      expect(builderRouteOf(reply.modal.customId)).toEqual({
        action: ITEM_MODAL,
        args: ['r', 'core.has_role'],
      });
    }
  });

  // A provider with no settings is fully configured by picking it, and Discord refuses an empty
  // modal — so it is added straight away.
  test('picking a requirement with no settings adds it immediately', async () => {
    const { deps, drafts } = await seeded();

    const reply = await handleBuilderComponent(deps, {
      action: BUILDER_ADD_REQUIREMENT,
      args: [],
      guildId: GUILD,
      channelId: CHANNEL,
      userId: HOST,
      values: ['core.is_booster'],
    });

    expect(reply.kind).toBe('update');
    expect((await drafts.get(draftKey(GUILD, HOST)))?.requirements).toEqual([
      { providerId: 'core.is_booster', config: {} },
    ]);
  });

  test('submitting the item modal stores the parsed config', async () => {
    const { deps, drafts } = await seeded();

    const reply = await handleBuilderModal(deps, {
      action: ITEM_MODAL,
      args: ['r', 'core.has_role'],
      guildId: GUILD,
      userId: HOST,
      fields: {},
      values: { roleIds: [ROLE], mode: ['any'] },
    });

    expect(reply.kind).toBe('update');

    const draft = await drafts.get(draftKey(GUILD, HOST));
    expect(draft?.requirements[0]).toEqual({
      providerId: 'core.has_role',
      config: { roleIds: [ROLE], mode: 'any' },
    });
  });

  test('an invalid modal answer comes back as a message, not a stored requirement', async () => {
    const { deps, drafts } = await seeded();

    const reply = await handleBuilderModal(deps, {
      action: ITEM_MODAL,
      args: ['r', 'core.account_age'],
      guildId: GUILD,
      userId: HOST,
      fields: { duration: 'a fortnight' },
      values: { operator: ['older-than'] },
    });

    expect(reply.kind).toBe('message');
    expect((await drafts.get(draftKey(GUILD, HOST)))?.requirements).toEqual([]);
  });

  test('the basics modal sets the prize, duration and winners', async () => {
    const { deps, drafts } = await seeded();

    const reply = await handleBuilderModal(deps, {
      action: BASICS_MODAL,
      args: [],
      guildId: GUILD,
      userId: HOST,
      fields: { title: 'Nitro', description: 'Have fun', duration: '12h', winners: '3' },
      values: {},
    });

    expect(reply.kind).toBe('update');

    const draft = await drafts.get(draftKey(GUILD, HOST));
    expect(draft?.title).toBe('Nitro');
    expect(draft?.winnerCount).toBe(3);
    expect(draft?.durationMs).toBe(12 * 60 * 60 * 1000);
  });

  test('a bad duration in the basics modal is refused with an example', async () => {
    const { deps, drafts } = await seeded();

    const reply = await handleBuilderModal(deps, {
      action: BASICS_MODAL,
      args: [],
      guildId: GUILD,
      userId: HOST,
      fields: { title: 'Nitro', duration: 'soon', winners: '1' },
      values: {},
    });

    expect(reply.kind).toBe('message');
    if (reply.kind === 'message') expect(reply.content).toContain('30m');
    expect((await drafts.get(draftKey(GUILD, HOST)))?.title).toBe('');
  });

  test('toggling the logic flips between all and any', async () => {
    const { deps, drafts } = await seeded();

    await handleBuilderComponent(deps, {
      action: BUILDER_LOGIC,
      args: [],
      guildId: GUILD,
      channelId: CHANNEL,
      userId: HOST,
      values: [],
    });

    expect((await drafts.get(draftKey(GUILD, HOST)))?.requirementLogic).toBe('any');
  });

  test('remove takes the chosen item out', async () => {
    const { deps, drafts } = await seeded();

    await handleBuilderComponent(deps, {
      action: BUILDER_ADD_REQUIREMENT,
      args: [],
      guildId: GUILD,
      channelId: CHANNEL,
      userId: HOST,
      values: ['core.is_booster'],
    });

    await handleBuilderComponent(deps, {
      action: BUILDER_REMOVE,
      args: [],
      guildId: GUILD,
      channelId: CHANNEL,
      userId: HOST,
      values: ['r:0'],
    });

    expect((await drafts.get(draftKey(GUILD, HOST)))?.requirements).toEqual([]);
  });

  test('cancel deletes the draft', async () => {
    const { deps, drafts } = await seeded();

    const reply = await handleBuilderComponent(deps, {
      action: BUILDER_CANCEL,
      args: [],
      guildId: GUILD,
      channelId: CHANNEL,
      userId: HOST,
      values: [],
    });

    expect(reply.kind).toBe('message');
    expect(await drafts.get(draftKey(GUILD, HOST))).toBeNull();
  });

  test('somebody else’s expired draft is explained rather than silently ignored', async () => {
    const deps = {
      store: new MemoryGiveawayStore(),
      providers: registry(),
      drafts: new MemoryDraftStore(),
      availability,
      now: () => NOW,
    };

    const reply = await handleBuilderComponent(deps, {
      action: BUILDER_LOGIC,
      args: [],
      guildId: GUILD,
      channelId: CHANNEL,
      userId: HOST,
      values: [],
    });

    expect(reply.kind).toBe('message');
    if (reply.kind === 'message') expect(reply.content).toContain('/giveaway create');
  });

  test('a provider that vanished between opening and submitting is explained', async () => {
    const { deps } = await seeded();

    const reply = await handleBuilderModal(deps, {
      action: ITEM_MODAL,
      args: ['r', 'leveling.level'],
      guildId: GUILD,
      userId: HOST,
      fields: { min: '5' },
      values: {},
    });

    expect(reply.kind).toBe('message');
    if (reply.kind === 'message') expect(reply.content).toContain('switched off');
  });
});
