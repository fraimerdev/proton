import type { PlaceholderDefinitionInput } from '../definitions.ts';
import { isHttpUrl } from '../format.ts';
import {
  type PlaceholderValue,
  type ResolvedValue,
  typeOf,
  placeholderValue as v,
} from '../values.ts';
import type { BotFacts } from './facts.ts';
import { isSnowflake, userAvatarUrl } from './user.ts';

export const PROTON_SUPPORT_URL = 'https://discord.gg/rWWJ2AUMby';

const BOT_KEYS = ['id', 'mention', 'name', 'avatar_url', 'website_url', 'support_url'] as const;

type BotKey = (typeof BOT_KEYS)[number];

type Entry = readonly [label: string, description: string, example: PlaceholderValue];

const EXAMPLE_BOT = '100000000000000099';

const BOT: Record<BotKey, Entry> = {
  id: ["Proton's ID", "Proton's Discord user id", v.text(EXAMPLE_BOT)],
  mention: ['Proton', 'Mentions Proton', v.user(EXAMPLE_BOT, 'Proton')],
  name: ["Proton's name", "Proton's name on Discord", v.text('Proton')],
  avatar_url: [
    "Proton's avatar",
    "Proton's avatar image",
    v.imageUrl('https://cdn.discordapp.com/embed/avatars/0.png'),
  ],
  website_url: ['Dashboard', 'The Proton dashboard', v.url('https://prtn.xyz')],
  support_url: [
    'Support server',
    'An invite to the Proton support server',
    v.url(PROTON_SUPPORT_URL),
  ],
};

export function botDefinitions(): PlaceholderDefinitionInput[] {
  return BOT_KEYS.map((key) => {
    const [label, description, example] = BOT[key];
    return {
      key: `bot.${key}`,
      label,
      description,
      group: 'Proton',
      type: typeOf(example),
      example,
    };
  });
}

const NOT_PROVIDED = 'the process running modules did not provide placeholders';

const NOT_READ = 'Proton could not read its own profile';

function link(url: string): ResolvedValue {
  return isHttpUrl(url)
    ? v.url(url)
    : v.failed('the address Proton holds is not an http or https link');
}

export function buildBotValues(facts: BotFacts | null): Record<string, ResolvedValue> {
  if (facts === null) {
    return Object.fromEntries(
      BOT_KEYS.map((key) => [
        `bot.${key}`,
        key === 'support_url' ? v.url(PROTON_SUPPORT_URL) : v.unavailable(NOT_PROVIDED),
      ]),
    );
  }

  const { id, name, avatarHash, websiteUrl } = facts;
  const avatar = avatarHash === undefined || avatarHash === null ? null : avatarHash;
  const avatarLink = userAvatarUrl(id, avatar);

  const values: Record<BotKey, ResolvedValue> = {
    id: v.text(id),
    mention: isSnowflake(id) ? v.user(id, name ?? undefined) : v.failed(NOT_READ),
    name:
      name === undefined
        ? v.unavailable('Proton has not read its own profile yet')
        : name === null
          ? v.failed(NOT_READ)
          : v.text(name),
    avatar_url:
      name === null
        ? v.failed(NOT_READ)
        : avatarHash === undefined
          ? v.unavailable('Proton has not read its own avatar yet')
          : avatarLink === null
            ? v.failed(NOT_READ)
            : v.imageUrl(avatarLink),
    website_url:
      websiteUrl === undefined
        ? v.unavailable('no dashboard address is configured')
        : link(websiteUrl),
    support_url: link(facts.supportUrl),
  };

  return Object.fromEntries(BOT_KEYS.map((key) => [`bot.${key}`, values[key]]));
}
