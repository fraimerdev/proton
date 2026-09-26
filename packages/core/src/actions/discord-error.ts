import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { z } from 'zod';
import { permissionLabels } from '../permissions/bits.ts';
import {
  createChannelPayloadSchema,
  editChannelPayloadSchema,
  roleChangePayloadSchema,
} from './payloads.ts';
import { type PrecheckInput, whereItIsMissing } from './prechecks.ts';
import type { ActionRequest } from './types.ts';

const discordErrorBodySchema = z.looseObject({
  code: z.number().int().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  errors: z.unknown().optional(),
});

type DiscordErrorBody = z.infer<typeof discordErrorBodySchema>;

interface FormErrorLeaf {
  line: string;
  code: unknown;
}

export interface DiscordErrorContext {
  status: number;
  body: unknown;
  request: Pick<ActionRequest, 'kind' | 'payload'>;
  resolved: PrecheckInput;
}

const MAX_DETAIL_LEAVES = 5;

const NOT_JSON_PREVIEW = 200;

const PROTON_FAULT_CODES: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.GeneralError,
  RESTJSONErrorCodes.InvalidFormBodyOrContentType,
  RESTJSONErrorCodes.RequestBodyContainsInvalidJSON,
]);

const CLOSED_DIRECT_MESSAGE_CODES: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.CannotSendMessagesToThisUser,
  RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds,
]);

const DIRECT_MESSAGE_REFUSED =
  "Discord wouldn't allow a DM to that user. No setting in this server changes that.";

const markedDirectMessageSchema = z.object({ directMessage: z.literal(true) });

const BY_CODE: ReadonlyMap<number, string> = new Map([
  [
    RESTJSONErrorCodes.CannotSendMessagesToThisUser,
    "That user doesn't accept DMs from Proton. No setting in this server changes that.",
  ],
  [
    RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds,
    "That user no longer shares a server with Proton, so Discord won't allow DMs to them. No " +
      'setting in this server changes that.',
  ],
  [RESTJSONErrorCodes.UnknownBan, "That user isn't banned here, so there's nothing left to lift."],
  [
    RESTJSONErrorCodes.MaximumNumberOfPinsReachedForTheChannel,
    "That channel already has Discord's maximum of 250 pinned messages, so nothing was pinned.",
  ],
  [
    RESTJSONErrorCodes.MaximumNumberOfGuildRolesReached,
    "This server already has Discord's maximum of 250 roles, so no role was created.",
  ],
  [
    RESTJSONErrorCodes.MaximumNumberOfGuildChannelsReached,
    "This server already has Discord's maximum of 500 channels, so no channel was created.",
  ],
  [
    RESTJSONErrorCodes.MaximumNumberOfReactionsReached,
    "That message already has Discord's maximum of 20 different reactions, so nothing was added.",
  ],
  [
    RESTJSONErrorCodes.TargetUserIsNotConnectedToVoice,
    "That member isn't in a voice channel, so there's nothing left to move or disconnect.",
  ],
  [
    RESTJSONErrorCodes.InvalidActionOnArchivedThread,
    "That thread is archived, so Discord won't accept changes in it and nothing was changed.",
  ],
  [
    RESTJSONErrorCodes.ThreadLocked,
    "That thread is locked, so Discord won't accept changes in it and nothing was changed.",
  ],
  [
    RESTJSONErrorCodes.MessageWasBlockedByAutomaticModeration,
    "This server's AutoMod blocked Proton's message, so it didn't go through.",
  ],
  [
    RESTJSONErrorCodes.MessageBlockedByHarmfulLinksFilter,
    "Discord's harmful-links filter blocked Proton's message, so it didn't go through.",
  ],
  [
    RESTJSONErrorCodes.OneOfTheMessagesProvidedWasTooOldForBulkDelete,
    "Discord won't bulk-delete messages older than 14 days, so nothing was deleted.",
  ],
]);

const BY_FORM_ERROR: ReadonlyMap<string, string> = new Map([
  [
    'CHANNEL_PARENT_MAX_CHANNELS',
    "That category already holds Discord's maximum of 50 channels, so nothing was changed.",
  ],
  [
    'AUTO_MODERATION_MAX_RULES_OF_TYPE_EXCEEDED',
    "This server already has Discord's maximum number of AutoMod rules of that type, so no rule " +
      'was created.',
  ],
]);

function parseErrorBody(body: unknown): DiscordErrorBody | undefined {
  const parsed = discordErrorBodySchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function* formErrorLeaves(value: unknown, key = ''): Generator<FormErrorLeaf> {
  if (!isRecord(value)) return;

  if (typeof value.message === 'string') {
    const code = String(value.code);
    yield { line: `${key ? `${key}[${code}]` : code}: ${value.message}`.trim(), code: value.code };
    return;
  }

  for (const [name, entry] of Object.entries(value)) {
    const next = name.startsWith('_')
      ? key
      : !key
        ? name
        : Number.isNaN(Number(name))
          ? `${key}.${name}`
          : `${key}[${name}]`;

    if (typeof entry === 'string') {
      yield { line: entry, code: undefined };
    } else if (isRecord(entry) && Array.isArray(entry._errors)) {
      for (const error of entry._errors) yield* formErrorLeaves(error, next);
    } else {
      yield* formErrorLeaves(entry, next);
    }
  }
}

function describeFormErrors(errors: unknown): string | undefined {
  for (const leaf of formErrorLeaves(errors)) {
    const sentence = typeof leaf.code === 'string' ? BY_FORM_ERROR.get(leaf.code) : undefined;
    if (sentence) return sentence;
  }
  return undefined;
}

export function discordDetail(body: unknown): string | undefined {
  const parsed = parseErrorBody(body);
  if (!parsed) return undefined;

  const message = parsed.message || undefined;
  const head =
    parsed.code === undefined
      ? message
      : message
        ? `${message} (${parsed.code})`
        : `code ${parsed.code}`;

  const leaves: string[] = [];
  for (const leaf of formErrorLeaves(parsed.errors)) {
    if (leaves.length === MAX_DETAIL_LEAVES) break;
    leaves.push(leaf.line);
  }

  const lines = head ? [head, ...leaves] : leaves;
  return lines.length > 0 ? lines.join('\n') : undefined;
}

export function refusalDetail(status: number, body: unknown): string {
  if (typeof body === 'string') {
    const text = body.replace(/\s+/g, ' ').trim().slice(0, NOT_JSON_PREVIEW);
    return text ? `Discord answered ${status} (not JSON): ${text}` : `Discord answered ${status}`;
  }

  const parsed = parseErrorBody(body);
  if (parsed?.error !== undefined && parsed.code === undefined) {
    const said = parsed.message ? `: ${parsed.message}` : '';
    return `the REST proxy answered ${status} (${parsed.error})${said}`;
  }

  const said = discordDetail(body);
  return `Discord answered ${status}${said ? `: ${said}` : ''}`;
}

export function describeDiscordError(context: DiscordErrorContext): string {
  const parsed = parseErrorBody(context.body);
  const code = parsed?.code;

  if (refusedDirectMessage(context, code)) return DIRECT_MESSAGE_REFUSED;

  return (
    (code === undefined ? undefined : describeCode(code, parsed?.errors, context)) ??
    describeStatus(context.status, code)
  );
}

function isDirectMessage({ request, resolved }: DiscordErrorContext): boolean {
  if (request.kind === 'create_dm') return true;

  // resolve-context ignores the mark on a channel it knows, and judged that send as a server one
  return (
    request.kind === 'send' &&
    resolved.channelId === undefined &&
    markedDirectMessageSchema.safeParse(request.payload).success
  );
}

function refusedDirectMessage(context: DiscordErrorContext, code: number | undefined): boolean {
  if (!isDirectMessage(context)) return false;
  if (code !== undefined && CLOSED_DIRECT_MESSAGE_CODES.has(code)) return false;

  return (
    context.status === 403 ||
    code === RESTJSONErrorCodes.MissingPermissions ||
    code === RESTJSONErrorCodes.MissingAccess
  );
}

function describeCode(
  code: number,
  errors: unknown,
  { request, resolved }: DiscordErrorContext,
): string | undefined {
  if (code === RESTJSONErrorCodes.MissingPermissions) return missingPermission(request, resolved);
  if (code === RESTJSONErrorCodes.MissingAccess) return missingAccess(request, resolved);

  if (code === RESTJSONErrorCodes.InvalidFormBodyOrContentType) return describeFormErrors(errors);

  return BY_CODE.get(code);
}

function missingPermission(
  request: DiscordErrorContext['request'],
  resolved: PrecheckInput,
): string | undefined {
  const labels = permissionLabels(resolved.requiredPermissions);
  if (labels.length === 0) return undefined;

  const categoryId = categoryOf(request);
  const where = categoryId
    ? `the <#${categoryId}> category and in ${whereItIsMissing(resolved)}`
    : whereItIsMissing(resolved);

  return (
    `Discord says a permission is missing: this needs ${labels.join(', ')} in ` +
    `${where}${likelyCause(request, resolved)}`
  );
}

function likelyCause(request: DiscordErrorContext['request'], resolved: PrecheckInput): string {
  switch (request.kind) {
    case 'timeout':
      return (
        ", Proton's highest role must be above theirs, and Discord won't time out a member who " +
        'has Administrator.'
      );
    case 'untimeout':
      return (
        ", Proton's highest role must be above theirs, and Discord won't change the timeout of a " +
        'member who has Administrator.'
      );
    case 'add_role':
    case 'remove_role': {
      const change = roleChangePayloadSchema.safeParse(request.payload);
      return roleBelowMine(change.success ? change.data.roleId : undefined);
    }
    case 'delete_role':
      return roleBelowMine(resolved.role?.id);
    case 'ban':
    case 'kick':
    case 'set_member_nickname':
      return resolved.target && resolved.hierarchy !== false && resolved.targetIsMember !== false
        ? ", and Proton's highest role must be above theirs."
        : '.';
    case 'lockdown':
    case 'unlock':
    case 'set_channel_overwrite':
    case 'create_channel':
    case 'edit_channel':
      return ", and Proton must hold every permission the channel's overwrites allow or deny.";
    default:
      return '.';
  }
}

function roleBelowMine(roleId: string | undefined): string {
  return `, and ${roleId ? `<@&${roleId}>` : 'the role'} must sit below Proton's highest role.`;
}

function categoryOf(request: DiscordErrorContext['request']): string | undefined {
  if (request.kind === 'create_channel') {
    const parsed = createChannelPayloadSchema.safeParse(request.payload);
    return parsed.success ? parsed.data.parentId : undefined;
  }
  if (request.kind === 'edit_channel') {
    const parsed = editChannelPayloadSchema.safeParse(request.payload);
    return parsed.success ? parsed.data.parentId : undefined;
  }
  return undefined;
}

function missingAccess(request: DiscordErrorContext['request'], resolved: PrecheckInput): string {
  const channelId = resolved.channelId;
  const categoryId = categoryOf(request);

  if (channelId && categoryId) {
    return (
      `Missing View Channel in <#${channelId}> and in the <#${categoryId}> category it's ` +
      'going into.'
    );
  }

  if (channelId && resolved.threadParentId) {
    return (
      `Missing View Channel for <#${channelId}>. A thread takes its permissions from ` +
      `<#${resolved.threadParentId}>, so grant it there.`
    );
  }

  if (channelId) return `Missing View Channel in <#${channelId}>.`;

  if (categoryId)
    return `Missing View Channel and Manage Channels in the <#${categoryId}> category.`;

  return (
    'Discord refused access to something this needs, usually a channel or category Proton ' +
    "can't see."
  );
}

function describeStatus(status: number, code: number | undefined): string {
  if (status === 403) {
    return "Discord refused that. It's usually a missing permission, or a role ranked above Proton's.";
  }
  if (status === 404) {
    return (
      "Couldn't find what that was meant to act on. It may have been deleted, or the member may " +
      'have left.'
    );
  }
  if (status === 429) {
    return "Discord is rate limiting Proton right now, so that didn't go through.";
  }
  if (status >= 500) {
    return 'Discord is having trouble right now, so that may not have gone through.';
  }
  if (code !== undefined && !PROTON_FAULT_CODES.has(code)) {
    return 'Discord refused that, and nothing was changed.';
  }

  return (
    'Discord refused that, and nothing was changed. This is a Proton problem, not a setting in ' +
    'this server.'
  );
}
