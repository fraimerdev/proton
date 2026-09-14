import {
  createPlaceholderRegistry,
  lookupFrom,
  type PlaceholderDefinitionInput,
  type PlaceholderType,
  type PlaceholderValue,
  type RenderOptions,
  type RenderResult,
  type ResolvedValue,
  renderTemplate,
  placeholderValue as v,
} from '../../src/placeholders/index.ts';

export const MEMBER = '123456789012345678';
export const ROLE = '223456789012345678';
export const AT = 1_700_000_000_000;

export function define(
  key: string,
  type: PlaceholderType,
  example: PlaceholderValue,
  extra: Partial<PlaceholderDefinitionInput> = {},
): PlaceholderDefinitionInput {
  return { key, type, example, label: key, group: key.split('.')[0] ?? 'misc', ...extra };
}

export const STANDARD: PlaceholderDefinitionInput[] = [
  define('member.mention', 'mention', v.user(MEMBER, 'Ada'), { aliases: ['user'] }),
  define('member.display_name', 'text', v.text('Ada'), { aliases: ['username'] }),
  define('member.id', 'text', v.text(MEMBER)),
  define('member.joined_at', 'datetime', v.datetime(AT)),
  define('member.boosting', 'boolean', v.boolean(true)),
  define('member.roles', 'list<mention>', v.list('mention', [v.role(ROLE, 'Mods')])),
  define('server.name', 'text', v.text('Proton'), { aliases: ['server'] }),
  define('server.member_count', 'integer', v.integer(42), { aliases: ['memberCount'] }),
  define('server.icon_url', 'image_url', v.imageUrl('https://cdn.discordapp.com/icons/1/a.png')),
  define('stats.average', 'number', v.number(1.5)),
  define('poll.share', 'percent', v.percent(64)),
  define('giveaway.duration', 'duration', v.duration(7_500_000)),
  define('giveaway.winners', 'list<text>', v.list('text', [v.text('Ada')])),
  define('rules.body', 'markdown', v.markdown('**Be kind**')),
  define('appeal.link', 'url', v.url('https://prtn.xyz/appeal')),
  define('answer.<question_key>', 'text', v.text('I was hacked')),
  define('option.<key>.votes', 'integer', v.integer(3)),
  define('case.note', 'text', v.text('watch them'), { sensitivity: 'staff_only' }),
  define('boost.tier', 'integer', v.integer(2), { availability: { events: ['member.boosted'] } }),
  define('card.caption', 'text', v.text('Hi'), { availability: { fields: ['plain_text'] } }),
];

export const registry = createPlaceholderRegistry(STANDARD);

export function render(
  template: string,
  values: Readonly<Record<string, ResolvedValue>> = {},
  options: Partial<RenderOptions> = {},
): RenderResult {
  return renderTemplate(template, lookupFrom(values), {
    registry,
    field: 'discord_text',
    ...options,
  });
}

export function codes(result: { diagnostics: ReadonlyArray<{ code: string }> }): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}
