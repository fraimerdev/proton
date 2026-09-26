import {
  type ActionFailure,
  type ActionResult,
  type CustomIdFor,
  type DiscordMessageBody,
  type ModuleContext,
  toDiscordMessage,
} from '@proton/core';
import {
  clipGraphemes,
  collectMessageSites,
  type PlaceholderEnvironment,
  type ServerFacts,
  serverFactsFrom,
  type UserFacts,
  usedKeys,
} from '@proton/core/placeholders';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { plain } from './card.ts';
import type { ApplicationsConfig, FormConfig } from './config.ts';
import { APPLICATIONS_ACTOR, MODULE_ID } from './constants.ts';
import type { BoundApplicationsDeps } from './deps.ts';
import type { DmMessage } from './effects.ts';
import { APPLICANT_SURFACES, renderApplicantMessage } from './placeholders.ts';
import { STATUS_LABELS } from './status.ts';
import type { ApplicationRecord, ApplicationStore, ThreadRecord } from './store.ts';
import { referenceOf } from './web.ts';

type Ctx = ModuleContext<ApplicationsConfig>;

export type DmBody = Omit<DiscordMessageBody, 'allowedMentions'>;

export const DMS_CLOSED = 'Couldn’t DM the applicant: their DMs are closed to Proton.';
export const NO_MUTUAL_SERVER =
  'Couldn’t DM the applicant: they no longer share a server with Proton.';
export const DM_UNCONFIRMED = 'Proton couldn’t confirm the DM reached the applicant.';
export const DM_EMPTY = 'This form’s message is empty, so there was nothing to send.';
export const ONBOARDING_NOTE =
  '-# Some of your new roles are still being set up. Staff can see this and will sort it out.';

const CONTENT_MAX = 2000;

const NO_MUTUAL_SERVER_CODE = 50278;

const CLOSED_CODES: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.CannotSendMessagesToThisUser,
]);

const DECISIONS: ReadonlySet<DmMessage> = new Set(['accepted', 'rejected', 'waitlisted']);

const NO_CUSTOM_IDS: CustomIdFor = () => {
  throw new Error('an applicant DM carried a component, which the message schema refuses');
};

export interface ApplicantDmInput {
  message: DmMessage;
  form: FormConfig;
  application: ApplicationRecord;
  formName: string;
  thread: readonly Pick<ThreadRecord, 'kind' | 'body'>[];
  url: string | null;
  now: number;
  onboardingUnfinished?: boolean;
  moderatorId?: string | null;
}

export interface ApplicantDmFacts {
  user: UserFacts | null;
  server: ServerFacts | null;
  moderator: UserFacts | null;
}

export type ApplicantDm = { ok: true; body: DmBody } | { ok: false; humanReason: string };

function bare(id: string): UserFacts {
  return { id, username: null, globalName: null, avatarHash: null };
}

function uses(keys: ReadonlySet<string>, namespace: string, beyond: readonly string[] = []) {
  return [...keys].some((key) => key.startsWith(`${namespace}.`) && !beyond.includes(key));
}

const IDENTITY = ['user.id', 'user.mention', 'moderator.id', 'moderator.mention'];

function snowflake(value: string | null): value is string {
  return value !== null && /^\d{17,20}$/.test(value);
}

export function dmKeysOf(form: FormConfig, message: DmMessage): ReadonlySet<string> {
  if (message === 'expired') return new Set(['server.name']);

  return usedKeys(
    APPLICANT_SURFACES[message],
    collectMessageSites(form.messages[message], '').map(({ text }) => text),
    { allowedOnly: true },
  );
}

async function profile(
  placeholders: PlaceholderEnvironment | null,
  userId: string,
  wanted: boolean,
): Promise<UserFacts> {
  if (!wanted || placeholders === null) return bare(userId);

  try {
    return (await placeholders.user(userId)) ?? bare(userId);
  } catch {
    return bare(userId);
  }
}

async function serverOf(
  ctx: Pick<Ctx, 'guildId'>,
  deps: Pick<BoundApplicationsDeps, 'placeholders' | 'guildState'>,
  wanted: boolean,
): Promise<ServerFacts> {
  if (!wanted) return { id: ctx.guildId };

  try {
    if (deps.placeholders !== null) return await deps.placeholders.server(ctx.guildId);
    return serverFactsFrom((await deps.guildState?.get(ctx.guildId)) ?? null, ctx.guildId);
  } catch {
    return { id: ctx.guildId };
  }
}

export async function applicantDmFacts(
  ctx: Pick<Ctx, 'guildId'>,
  deps: Pick<BoundApplicationsDeps, 'placeholders' | 'guildState'>,
  input: Pick<ApplicantDmInput, 'message' | 'form' | 'application' | 'moderatorId'>,
): Promise<ApplicantDmFacts> {
  const keys = dmKeysOf(input.form, input.message);
  const decider = input.moderatorId ?? input.application.decidedBy;

  return {
    user: await profile(
      deps.placeholders,
      input.application.applicantId,
      uses(keys, 'user', IDENTITY),
    ),
    server: await serverOf(ctx, deps, uses(keys, 'server')),
    moderator:
      DECISIONS.has(input.message) && snowflake(decider)
        ? await profile(deps.placeholders, decider, uses(keys, 'moderator', IDENTITY))
        : null,
  };
}

function latestRequest(thread: ApplicantDmInput['thread']): string | null {
  const asked = thread.filter((entry) => entry.kind === 'info_request');
  return asked.at(-1)?.body ?? null;
}

function reviewedAt(message: DmMessage, application: ApplicationRecord): number | null {
  if (message === 'waitlisted') return application.waitlistedAt ?? application.decidedAt;
  return DECISIONS.has(message) ? application.decidedAt : null;
}

function expiredBody(input: ApplicantDmInput, facts: ApplicantDmFacts): DmBody {
  const server = facts.server?.name?.trim();
  const where = server ? ` in **${plain(server)}**` : '';

  return {
    content:
      `Your application ${referenceOf(input.application.number)} for ` +
      `**${plain(input.formName)}**${where} has expired because the question from staff ` +
      'wasn’t answered in time.',
  };
}

export function renderApplicantDm(input: ApplicantDmInput, facts: ApplicantDmFacts): ApplicantDm {
  const { application, message } = input;
  if (application.number === null) {
    return { ok: false, humanReason: 'This application was never sent, so there’s no DM for it.' };
  }

  if (message === 'expired') return { ok: true, body: expiredBody(input, facts) };

  const rendered = renderApplicantMessage(
    APPLICANT_SURFACES[message],
    input.form.messages[message],
    {
      user: facts.user,
      server: facts.server,
      moderator: facts.moderator,
      application: {
        number: application.number,
        formName: input.formName,
        statusLabel: STATUS_LABELS[application.status],
        submittedAt: application.submittedAt ?? application.createdAt,
        reviewedAt: reviewedAt(message, application),
        reason: DECISIONS.has(message) ? application.decisionReason : null,
        request: message === 'infoRequest' ? latestRequest(input.thread) : null,
        url: input.url,
      },
    },
    { now: input.now },
  );
  if (!rendered.ok) return { ok: false, humanReason: rendered.humanReason };

  let body: DmBody;
  try {
    const { allowedMentions: _ignored, ...rest } = toDiscordMessage(rendered.message, {
      customIdFor: NO_CUSTOM_IDS,
      now: new Date(input.now),
    });
    body = rest;
  } catch (error) {
    return { ok: false, humanReason: error instanceof Error ? error.message : String(error) };
  }

  if ((body.content ?? '').trim() === '' && (body.embeds?.length ?? 0) === 0) {
    return { ok: false, humanReason: DM_EMPTY };
  }
  return { ok: true, body: input.onboardingUnfinished === true ? withOnboardingNote(body) : body };
}

function withOnboardingNote(body: DmBody): DmBody {
  const content = (body.content ?? '').trimEnd();
  if (content === '') return { ...body, content: ONBOARDING_NOTE };

  const room = CONTENT_MAX - ONBOARDING_NOTE.length - 2;
  return { ...body, content: `${clipGraphemes(content, room)}\n\n${ONBOARDING_NOTE}` };
}

export type DmDelivery =
  | { outcome: 'sent'; channelId: string }
  | { outcome: 'closed' | 'no_mutual_server' }
  | { outcome: 'retry'; errorCode: string; error: string }
  | { outcome: 'failed'; errorCode: string; error: string };

function channelIdOf(result: ActionResult): string | null {
  const id = (result.body as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : null;
}

function mayHaveLanded(failure: ActionFailure | undefined): boolean {
  const code = failure?.code ?? '';
  return (
    code === 'transport_failure' ||
    code === 'guild_state_unavailable' ||
    code === 'target_state_unavailable' ||
    code === 'discord_429' ||
    /^discord_5\d\d$/.test(code)
  );
}

function undelivered(result: ActionResult): DmDelivery {
  const failure = result.failure;
  const discordCode = failure?.discordCode;

  if (discordCode === NO_MUTUAL_SERVER_CODE) return { outcome: 'no_mutual_server' };
  if (
    (discordCode !== undefined && CLOSED_CODES.has(discordCode)) ||
    (discordCode === undefined && failure?.code === 'discord_403')
  ) {
    return { outcome: 'closed' };
  }

  const errorCode = failure?.code ?? 'unknown';
  const error = failure?.humanReason ?? 'Discord refused the DM without saying why.';
  return mayHaveLanded(failure)
    ? { outcome: 'retry', errorCode, error }
    : { outcome: 'failed', errorCode, error };
}

// Stored before the send: a redelivered create_dm is skipped_duplicate with no channel id in it.
export async function deliverApplicantDm(
  ctx: Pick<Ctx, 'guildId' | 'executor'>,
  store: Pick<ApplicationStore, 'get' | 'rememberDm'>,
  input: { application: ApplicationRecord; body: DmBody; openKey: string; sendKey: string },
): Promise<DmDelivery> {
  const { application } = input;
  let channelId = application.dmChannelId;

  if (channelId === null) {
    const opened = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_dm',
      actorId: APPLICATIONS_ACTOR,
      targetId: application.applicantId,
      idempotencyKey: input.openKey,
      dryRun: false,
      record: false,
      payload: { userId: application.applicantId },
    });

    if (opened.status === 'executed') {
      channelId = channelIdOf(opened);
      if (channelId === null) {
        return {
          outcome: 'retry',
          errorCode: 'unconfirmed',
          error: 'Discord opened the DM without saying where.',
        };
      }
      await store.rememberDm(ctx.guildId, application.id, channelId);
    } else if (opened.status === 'skipped_duplicate') {
      channelId = (await store.get(ctx.guildId, application.id))?.dmChannelId ?? null;
      if (channelId === null) {
        return { outcome: 'retry', errorCode: 'unconfirmed', error: DM_UNCONFIRMED };
      }
    } else {
      return undelivered(opened);
    }
  }

  const sent = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: APPLICATIONS_ACTOR,
    targetId: application.applicantId,
    idempotencyKey: input.sendKey,
    dryRun: false,
    record: false,
    payload: { channelId, ...input.body, allowedMentions: { parse: [] }, directMessage: true },
  });

  if (sent.status === 'executed' || sent.status === 'skipped_duplicate') {
    return { outcome: 'sent', channelId };
  }
  return undelivered(sent);
}
