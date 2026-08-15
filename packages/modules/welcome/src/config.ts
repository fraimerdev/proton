import { CARD_PRESETS } from '@proton/cards';
import { protonFields } from '@proton/core';
import { z } from 'zod';

/** Bumped whenever the shape below changes (I5). */
export const WELCOME_SCHEMA_VERSION = 1;

/**
 * The placeholder vocabulary, in full.
 *
 * Deliberately four tokens and no expression syntax. A general template language
 * is the rule builder's problem (§9 says as much about the rule UI), and
 * inventing one here would fix its syntax before there is anything to argue with
 * — including the escaping rules, which is where template languages that grew by
 * accident all end up.
 *
 * `{user}` is a mention rather than a name on purpose: it pings the arriving
 * member, which is the point of a welcome, and it renders correctly whatever
 * their display name contains.
 */
export const WELCOME_PLACEHOLDERS = ['{user}', '{username}', '{server}', '{memberCount}'] as const;

export type WelcomePlaceholder = (typeof WELCOME_PLACEHOLDERS)[number];

export const DEFAULT_WELCOME_MESSAGE =
  'Welcome to {server}, {user}! You are member #{memberCount}.';
export const DEFAULT_GOODBYE_MESSAGE = '{username} has left {server}.';

const channelId = z
  .string()
  .regex(/^\d{17,20}$/, 'must be a Discord channel id')
  .register(protonFields, { field: 'channel-id' });

const welcomeShape = {
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Greet members when they join, and note when they leave.',
  }),

  welcomeChannelId: channelId.optional().register(protonFields, {
    label: 'Welcome channel',
    description: 'Where joins are announced. Leave empty to announce nothing on join.',
  }),

  welcomeMessage: z
    .string()
    .max(1000)
    .default(DEFAULT_WELCOME_MESSAGE)
    .register(protonFields, {
      label: 'Welcome message',
      description: `Placeholders: ${WELCOME_PLACEHOLDERS.join(', ')}.`,
    }),

  goodbyeChannelId: channelId.optional().register(protonFields, {
    label: 'Goodbye channel',
    description: 'Where leaves are noted. Leave empty to say nothing when someone leaves.',
  }),

  goodbyeMessage: z
    .string()
    .max(1000)
    .default(DEFAULT_GOODBYE_MESSAGE)
    .register(protonFields, {
      label: 'Goodbye message',
      description: `Placeholders: ${WELCOME_PLACEHOLDERS.join(', ')}.`,
    }),

  card: z.boolean().default(false).register(protonFields, {
    label: 'Attach a card',
    description: 'Render an image alongside the message. Costs a little more per join.',
  }),

  preset: z.enum(CARD_PRESETS).default('midnight').register(protonFields, {
    label: 'Card style',
    description: 'Which of the three built-in card designs to render.',
  }),
};

export const welcomeConfigSchema = z.object(welcomeShape);

export type WelcomeConfig = z.infer<typeof welcomeConfigSchema>;

export const welcomeDefaultConfig: WelcomeConfig = welcomeConfigSchema.parse({});

export interface GreetingFacts {
  userId: string;
  username: string;
  guildName: string;
  memberCount: number;
}

/**
 * Substitute the placeholders.
 *
 * A single pass over the known tokens rather than a regex replace loop, because
 * a replaced value can itself contain a token — a member calling themselves
 * `{server}` would otherwise have their name expanded on the second pass. One
 * pass makes substitution non-recursive by construction rather than by
 * escaping.
 */
export function renderGreeting(template: string, facts: GreetingFacts): string {
  const values: Record<WelcomePlaceholder, string> = {
    '{user}': `<@${facts.userId}>`,
    '{username}': facts.username,
    '{server}': facts.guildName,
    '{memberCount}': String(facts.memberCount),
  };

  let out = '';
  let index = 0;

  while (index < template.length) {
    const token = WELCOME_PLACEHOLDERS.find((placeholder) =>
      template.startsWith(placeholder, index),
    );

    if (token) {
      out += values[token];
      index += token.length;
    } else {
      out += template[index];
      index += 1;
    }
  }

  // Discord rejects a message body over 2000 characters outright, which would
  // turn a long template into no greeting at all.
  return out.slice(0, 2000);
}
