/**
 * Typed access to slash-command options.
 *
 * Discord delivers options as a flat-ish array of `{ name, type, value }`, with
 * subcommands nesting their own options one or two levels down. Handing that raw
 * shape to every module would mean each one re-implementing the same lookup and
 * type narrowing — and getting the subcommand nesting subtly wrong.
 */

/** Discord's ApplicationCommandOptionType. */
export const OptionType = {
  Subcommand: 1,
  SubcommandGroup: 2,
  String: 3,
  Integer: 4,
  Boolean: 5,
  User: 6,
  Channel: 7,
  Role: 8,
  Mentionable: 9,
  Number: 10,
  Attachment: 11,
} as const;

export interface RawOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: RawOption[];
}

/**
 * Thrown when a handler asks for an option as the wrong type.
 *
 * This can only happen if a command's registered schema and its handler
 * disagree, which is a programming error. It throws rather than returning null
 * because a silent null becomes "the bot did nothing" — the failure mode
 * PLAN.md §1 and §7 exist to eliminate. Throwing leaves the event unacked, so it
 * surfaces in the DLQ with the payload attached instead of vanishing.
 */
export class CommandOptionTypeError extends Error {
  constructor(name: string, expected: string, actualType: number) {
    super(
      `Command option '${name}' was requested as ${expected} but Discord sent type ${actualType}. ` +
        "The command's registered options and its handler disagree.",
    );
    this.name = 'CommandOptionTypeError';
  }
}

export interface CommandOptions {
  getString(name: string): string | null;
  getInteger(name: string): number | null;
  getNumber(name: string): number | null;
  getBoolean(name: string): boolean | null;
  /** USER options carry the user's snowflake — what ActionRequest.targetId wants. */
  getUserId(name: string): string | null;
  getChannelId(name: string): string | null;
  getRoleId(name: string): string | null;
  /** The invoked subcommand, if the command declares any. */
  getSubcommand(): string | null;
  getSubcommandGroup(): string | null;
  has(name: string): boolean;
}

interface Resolved {
  flat: Map<string, RawOption>;
  subcommand: string | null;
  group: string | null;
}

/**
 * Flatten Discord's nesting so handlers address options by name regardless of
 * whether the command uses subcommands.
 */
function resolve(raw: readonly RawOption[]): Resolved {
  let subcommand: string | null = null;
  let group: string | null = null;
  let current: readonly RawOption[] = raw;

  if (current.length === 1 && current[0]?.type === OptionType.SubcommandGroup) {
    group = current[0].name;
    current = current[0].options ?? [];
  }

  if (current.length === 1 && current[0]?.type === OptionType.Subcommand) {
    subcommand = current[0].name;
    current = current[0].options ?? [];
  }

  const flat = new Map<string, RawOption>();
  for (const option of current) flat.set(option.name, option);

  return { flat, subcommand, group };
}

export function createCommandOptions(raw: readonly RawOption[] = []): CommandOptions {
  const { flat, subcommand, group } = resolve(raw);

  function read(name: string, expectedTypes: number[], label: string): RawOption | null {
    const option = flat.get(name);
    if (!option || option.value === undefined) return null;
    if (!expectedTypes.includes(option.type)) {
      throw new CommandOptionTypeError(name, label, option.type);
    }
    return option;
  }

  return {
    getString(name) {
      const option = read(name, [OptionType.String], 'a string');
      return option ? String(option.value) : null;
    },

    getInteger(name) {
      const option = read(name, [OptionType.Integer], 'an integer');
      return option ? Number(option.value) : null;
    },

    getNumber(name) {
      const option = read(name, [OptionType.Number, OptionType.Integer], 'a number');
      return option ? Number(option.value) : null;
    },

    getBoolean(name) {
      const option = read(name, [OptionType.Boolean], 'a boolean');
      return option ? Boolean(option.value) : null;
    },

    // Snowflakes arrive as strings; Mentionable is accepted for user options
    // because Discord uses it when a command allows either a user or a role.
    getUserId(name) {
      const option = read(name, [OptionType.User, OptionType.Mentionable], 'a user');
      return option ? String(option.value) : null;
    },

    getChannelId(name) {
      const option = read(name, [OptionType.Channel], 'a channel');
      return option ? String(option.value) : null;
    },

    getRoleId(name) {
      const option = read(name, [OptionType.Role, OptionType.Mentionable], 'a role');
      return option ? String(option.value) : null;
    },

    getSubcommand: () => subcommand,
    getSubcommandGroup: () => group,
    has: (name) => flat.has(name),
  };
}
