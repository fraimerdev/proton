import { describe, expect, test } from 'bun:test';
import { dispatch, type GuildCommandDispatchName, guildCommandDispatches } from '@proton/fixtures';
import { InteractionType } from 'discord-api-types/v10';
import { contextMenuKey } from '../../src/commands/registration.ts';
import { subcommandPath } from '../../src/commands/visibility.ts';
import type { ProtonEvent } from '../../src/events/types.ts';
import { readAutocompleteInteraction, readResolved } from '../../src/interactions/read.ts';
import { createCommandOptions, type RawOption } from '../../src/modules/options.ts';

const GUILD_COMMANDS = Object.keys(guildCommandDispatches) as GuildCommandDispatchName[];

function dataOf(name: GuildCommandDispatchName): Record<string, unknown> {
  return dispatch(name).d.data as Record<string, unknown>;
}

function event(name: GuildCommandDispatchName): ProtonEvent {
  const raw = dispatch(name);
  return {
    id: `interaction.autocomplete:${String(raw.d.id)}`,
    type: 'interaction.autocomplete',
    guildId: String(raw.d.guild_id),
    occurredAt: 0,
    payload: raw.d,
  };
}

describe('guild-registered interaction fixtures', () => {
  test('there is one per kind of guild command interaction', () => {
    expect(GUILD_COMMANDS).toHaveLength(4);
  });

  test('their interaction ids are their own, so replaying them beside the rest dedupes nothing', () => {
    const ids = GUILD_COMMANDS.map((name) => String(dispatch(name).d.id));

    expect(new Set(ids).size).toBe(ids.length);
    for (const other of [
      'interactionCreatePing',
      'interactionCreateComponent',
      'interactionCreateModal',
      'interactionCreateAutocomplete',
      'interactionCreateUserCommand',
      'interactionCreateMessageCommand',
      'interactionCreateModalFileUpload',
      'interactionCreateComponentDm',
    ] as const) {
      expect(ids).not.toContain(String(dispatch(other).d.id));
    }
  });

  test.each(GUILD_COMMANDS)('%s names the guild its command is registered to', (name) => {
    const raw = dispatch(name);

    expect(dataOf(name).guild_id).toBe(raw.d.guild_id as string);
    expect(String(dataOf(name).id)).toMatch(/^\d{17,20}$/);
  });

  test('the slash command runs a subcommand the option reader and path agree on', () => {
    const options = dataOf('interactionCreateGuildCommand').options as RawOption[];
    const reader = createCommandOptions(options);

    expect(subcommandPath(options)).toBe('add');
    expect(reader.getUserId('user')).toBe('100000000000000003');
    expect(reader.getString('reason')).toBe('Posting scam links');
    expect(readResolved(dispatch('interactionCreateGuildCommand').d).members.size).toBe(1);
  });

  test('the menus are keyed by kind and name', () => {
    expect(contextMenuKey('user', String(dataOf('interactionCreateGuildUserCommand').name))).toBe(
      'user:Report user',
    );
    expect(
      contextMenuKey('message', String(dataOf('interactionCreateGuildMessageCommand').name)),
    ).toBe('message:Punish author');
  });

  test('the autocomplete reads as the same command and subcommand', () => {
    const read = readAutocompleteInteraction(event('interactionCreateGuildAutocomplete'));

    expect(dispatch('interactionCreateGuildAutocomplete').d.type).toBe(
      InteractionType.ApplicationCommandAutocomplete,
    );
    expect(read?.commandName).toBe('ban');
    expect(read?.subcommand).toBe('add');
    expect(read?.focused?.name).toBe('reason');
    expect(dataOf('interactionCreateGuildAutocomplete').id).toBe(
      dataOf('interactionCreateGuildCommand').id,
    );
  });
});
