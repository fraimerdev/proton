import { describe, expect, test } from 'bun:test';
import { type ForeignKey, GuildPurgeRefused, planGuildTables } from '../src/purge.ts';

const key = (child: string, parent: string, column: string, onDelete = 'c'): ForeignKey => ({
  child,
  parent,
  childColumns: [column],
  parentColumns: ['id'],
  onDelete,
});

const byTable = (withGuildId: string[], keys: ForeignKey[]) =>
  new Map(planGuildTables(withGuildId, keys).map((scope) => [scope.table, scope]));

describe('planGuildTables', () => {
  test('the guilds row itself is deleted directly, first', () => {
    const [first] = planGuildTables([], []);

    expect(first).toEqual({ table: 'guilds', removedBy: 'direct', predicate: '"id" = $1' });
  });

  test('a table keyed to guilds by a cascading foreign key goes with the guilds row', () => {
    const plan = byTable(['cases'], [key('cases', 'guilds', 'guild_id')]);

    expect(plan.get('cases')).toEqual({
      table: 'cases',
      removedBy: 'cascade',
      predicate: '"guild_id" = $1',
    });
  });

  test('a child with no guild_id column is counted through its parent, however deep', () => {
    const plan = byTable(
      ['giveaways'],
      [
        key('giveaways', 'guilds', 'guild_id'),
        key('giveaway_draws', 'giveaways', 'giveaway_id'),
        key('giveaway_wins', 'giveaway_draws', 'draw_id'),
      ],
    );

    expect(plan.get('giveaway_draws')?.predicate).toBe(
      '"giveaway_id" in (select "id" from "giveaways" where "guild_id" = $1)',
    );
    expect(plan.get('giveaway_wins')).toEqual({
      table: 'giveaway_wins',
      removedBy: 'cascade',
      predicate:
        '"draw_id" in (select "id" from "giveaway_draws" where "giveaway_id" in ' +
        '(select "id" from "giveaways" where "guild_id" = $1))',
    });
  });

  test('a table holding guild_id with no foreign key to guilds is deleted directly', () => {
    const plan = byTable(['message_logs', 'giveaway_events'], []);

    expect(plan.get('message_logs')?.removedBy).toBe('direct');
    expect(plan.get('giveaway_events')).toEqual({
      table: 'giveaway_events',
      removedBy: 'direct',
      predicate: '"guild_id" = $1',
    });
  });

  test('what cascades from a directly deleted table is counted through it', () => {
    const plan = byTable(['orphans'], [key('orphan_notes', 'orphans', 'orphan_id')]);

    expect(plan.get('orphan_notes')).toEqual({
      table: 'orphan_notes',
      removedBy: 'cascade',
      predicate: '"orphan_id" in (select "id" from "orphans" where "guild_id" = $1)',
    });
  });

  test('a child that also carries guild_id is matched on it, not through its parent', () => {
    const plan = byTable(
      ['tickets', 'ticket_events'],
      [key('tickets', 'guilds', 'guild_id'), key('ticket_events', 'tickets', 'ticket_id')],
    );

    expect(plan.get('ticket_events')).toEqual({
      table: 'ticket_events',
      removedBy: 'cascade',
      predicate: '"guild_id" = $1',
    });
  });

  test('foreign keys between tables no server owns are left alone', () => {
    const plan = byTable([], [key('session', 'user', 'userId', 'c'), key('x', 'y', 'y_id', 'r')]);

    expect([...plan.keys()]).toEqual(['guilds']);
  });

  test('a composite key is matched as a row', () => {
    const plan = byTable(
      ['parents'],
      [
        key('parents', 'guilds', 'guild_id'),
        {
          child: 'kids',
          parent: 'parents',
          childColumns: ['a', 'b'],
          parentColumns: ['x', 'y'],
          onDelete: 'c',
        },
      ],
    );

    expect(plan.get('kids')?.predicate).toBe(
      '("a", "b") in (select "x", "y" from "parents" where "guild_id" = $1)',
    );
  });

  test('refuses, naming the table, when a server-owned row is held by a non-cascading key', () => {
    const plan = () =>
      planGuildTables(
        ['cases'],
        [key('cases', 'guilds', 'guild_id'), key('case_notes', 'cases', 'case_id', 'a')],
      );

    expect(plan).toThrow(GuildPurgeRefused);
    expect(plan).toThrow(/case_notes references cases without ON DELETE CASCADE/);
  });

  test('a set-null key is refused too, because it would leave the rows behind', () => {
    expect(() => planGuildTables([], [key('audit', 'guilds', 'guild_id', 'n')])).toThrow(
      /audit references guilds/,
    );
  });
});
