// /presets, not the barrel: the barrel reaches @napi-rs/canvas, a native addon that the
// dashboard's bundler cannot load. Config is read in the browser.
import { CARD_PRESETS } from '@proton/cards/presets';
import {
  interactiveKeys,
  liftLegacyMessage,
  MESSAGE_CONTENT_MAX,
  messageObjectSchema,
  protonFields,
  refineMessage,
  substitute,
} from '@proton/core';
import { z } from 'zod';

export const WELCOME_SCHEMA_VERSION = 4;

export const WELCOME_PLACEHOLDERS = ['{user}', '{username}', '{server}', '{memberCount}'] as const;

export type WelcomePlaceholder = (typeof WELCOME_PLACEHOLDERS)[number];

export const DEFAULT_WELCOME_MESSAGE =
  'Welcome to {server}, {user}! You are member #{memberCount}.';
export const DEFAULT_GOODBYE_MESSAGE = '{username} has left {server}.';

const ONLY_LINK_BUTTONS =
  'a welcome or goodbye message can carry link buttons and nothing else: the welcome module has ' +
  'no interaction listener, so a press on anything else would go unanswered. Make this a link ' +
  'button, or post the interactive message with the Embeds module instead.';

export function liftLegacyGreeting(value: unknown): unknown {
  // A greeting stored before it could hold embeds is a bare string, and z.object would strip it to
  // an empty message that the next write — a sidebar toggle sends no config — would then persist.
  if (typeof value === 'string') return { content: value };

  return liftLegacyMessage(value);
}

type GreetingShape = z.infer<typeof messageObjectSchema>;

export function isSilentGreeting(message: GreetingShape): boolean {
  return (
    (message.content?.trim().length ?? 0) === 0 &&
    message.embeds.length === 0 &&
    message.components.length === 0 &&
    message.v2.length === 0
  );
}

function refineGreeting(message: GreetingShape, ctx: z.RefinementCtx): void {
  // An empty greeting is how a guild says "announce nothing", so refineMessage's nothing-to-send
  // rule must not see it.
  if (isSilentGreeting(message)) return;

  refineMessage(message, ctx);

  for (const [row, component] of message.components.entries()) {
    if (component.kind !== 'buttons') {
      ctx.addIssue({ code: 'custom', path: ['components', row], message: ONLY_LINK_BUTTONS });
      continue;
    }

    for (const [index, button] of component.buttons.entries()) {
      if (button.style === 'link') continue;

      ctx.addIssue({
        code: 'custom',
        path: ['components', row, 'buttons', index, 'style'],
        message: ONLY_LINK_BUTTONS,
      });
    }
  }

  if (interactiveKeys({ components: [], v2: message.v2 }).length > 0) {
    ctx.addIssue({ code: 'custom', path: ['v2'], message: ONLY_LINK_BUTTONS });
  }
}

export const greetingMessageSchema = z.preprocess(
  liftLegacyGreeting,
  messageObjectSchema.superRefine(refineGreeting),
);

export type GreetingMessage = z.infer<typeof greetingMessageSchema>;

export const DEFAULT_WELCOME_GREETING: GreetingMessage =
  greetingMessageSchema.parse(DEFAULT_WELCOME_MESSAGE);
export const DEFAULT_GOODBYE_GREETING: GreetingMessage =
  greetingMessageSchema.parse(DEFAULT_GOODBYE_MESSAGE);

const channelId = z
  .string()
  .regex(/^\d{17,20}$/, 'must be a Discord channel id')
  .register(protonFields, { field: 'channel-id' });

const welcomeShape = {
  enabled: z.boolean().default(false).register(protonFields, { label: 'Enabled' }),

  welcomeChannelId: channelId.optional().register(protonFields, { label: 'Welcome channel' }),

  welcomeMessage: greetingMessageSchema.default(DEFAULT_WELCOME_GREETING),

  goodbyeChannelId: channelId.optional().register(protonFields, { label: 'Goodbye channel' }),

  goodbyeMessage: greetingMessageSchema.default(DEFAULT_GOODBYE_GREETING),

  card: z.boolean().default(false).register(protonFields, {
    label: 'Attach a card',
    description: 'Costs an extra image render per join',
  }),

  preset: z.enum(CARD_PRESETS).default('midnight').register(protonFields, { label: 'Card style' }),

  cardAccent: z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .default(0x5865f2)
    .register(protonFields, { field: 'colour', label: 'Accent colour' }),

  cardBackgroundUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional()
    .register(protonFields, {
      label: 'Background image',
      description: 'Only images hosted on Discord’s CDN load',
    }),

  cardShowMemberCount: z
    .boolean()
    .default(true)
    .register(protonFields, { label: 'Show the member count' }),
};

export const welcomeConfigSchema = z.object(welcomeShape);

export type WelcomeConfig = z.infer<typeof welcomeConfigSchema>;

export const welcomeFormSchema = welcomeConfigSchema.omit({
  welcomeMessage: true,
  goodbyeMessage: true,
});

export const welcomeDefaultConfig: WelcomeConfig = welcomeConfigSchema.parse({});

export interface GreetingFacts {
  userId: string;
  username: string;
  guildName: string;
  memberCount: number;
}

type GreetingVars = Readonly<Record<string, string>>;

function greetingVars(facts: GreetingFacts): GreetingVars {
  return {
    user: `<@${facts.userId}>`,
    username: facts.username,
    server: facts.guildName,
    memberCount: String(facts.memberCount),
  };
}

export function renderGreeting(message: GreetingMessage, facts: GreetingFacts): GreetingMessage {
  const rendered = substitute(message, greetingVars(facts)) as GreetingMessage;
  const content = rendered.content;

  if (content === undefined || content.length <= MESSAGE_CONTENT_MAX) return rendered;

  return { ...rendered, content: content.slice(0, MESSAGE_CONTENT_MAX) };
}
