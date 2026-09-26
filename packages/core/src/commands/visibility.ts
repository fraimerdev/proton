import { z } from 'zod';
import { OptionType, type RawOption } from '../modules/options.ts';
import { type CommandData, leafPaths } from './fields.ts';

export const REPLY_VISIBILITIES = ['private', 'public'] as const;

export const replyVisibilitySchema = z.enum(REPLY_VISIBILITIES);

export type ReplyVisibility = z.infer<typeof replyVisibilitySchema>;

export const replyInheritsFromSchema = z.object({
  label: z.string().min(1),
  moduleId: z.string().min(1),
});

export type ReplyInheritsFrom = z.infer<typeof replyInheritsFromSchema>;

// A method, as handler is: an arrow type stops a module's command fitting CommandDefinition.
type ReplyDefault<C> = {
  bivariant(config: C, path: string): ReplyVisibility;
}['bivariant'];

export interface CommandReplyPolicy<C = unknown> {
  default: ReplyVisibility | ReplyDefault<C>;
  toggleable: readonly string[];
  inheritsFrom?: ReplyInheritsFrom;
}

export const replyControlSchema = z.object({
  supported: z.boolean(),
  paths: z.array(
    z.object({
      path: z.string(),
      default: replyVisibilitySchema,
      toggleable: z.boolean(),
    }),
  ),
  inheritsFrom: replyInheritsFromSchema.optional(),
});

export type ReplyControl = z.infer<typeof replyControlSchema>;

export function subcommandPath(raw: readonly RawOption[] | undefined): string {
  let current: readonly RawOption[] = raw ?? [];
  let group: string | null = null;
  let subcommand: string | null = null;

  if (current.length === 1 && current[0]?.type === OptionType.SubcommandGroup) {
    group = current[0].name;
    current = current[0].options ?? [];
  }

  if (current.length === 1 && current[0]?.type === OptionType.Subcommand) {
    subcommand = current[0].name;
  }

  return [group, subcommand].filter(Boolean).join('.');
}

export function replyDefault<C>(
  policy: CommandReplyPolicy<C>,
  config: C,
  path: string,
): ReplyVisibility {
  return typeof policy.default === 'function' ? policy.default(config, path) : policy.default;
}

export function resolvePrivateReply<C>(
  policy: CommandReplyPolicy<C>,
  config: C,
  path: string,
  preference: boolean | null,
): boolean {
  if (preference !== null && policy.toggleable.includes(path)) return preference;
  return replyDefault(policy, config, path) === 'private';
}

export function replyControl<C>(
  policy: CommandReplyPolicy<C> | undefined,
  data: CommandData,
  config: C,
): ReplyControl | null {
  if (!policy) return null;

  const paths = leafPaths(data).map((path) => ({
    path,
    default: replyDefault(policy, config, path),
    toggleable: policy.toggleable.includes(path),
  }));

  return {
    supported: paths.some((path) => path.toggleable),
    paths,
    ...(policy.inheritsFrom ? { inheritsFrom: { ...policy.inheritsFrom } } : {}),
  };
}
