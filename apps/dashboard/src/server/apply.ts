import { snowflakeSchema } from '@proton/core';
import { FORM_ID_MAX, INFO_RESPONSE_MAX, SLUG } from '@proton/module-applications/constants';
import { draftAnswersSchema } from '@proton/module-applications/questions';
import {
  type DraftSaveResult,
  draftSaveBodySchema,
  draftSaveResultSchema,
  type MyApplications,
  myApplicationsSchema,
  type PortalApplication,
  type PortalDiscardResult,
  type PortalForm,
  type PortalGuild,
  type PortalSubmitResult,
  portalApplicationSchema,
  portalDiscardResultSchema,
  portalFormSchema,
  portalGuildSchema,
  portalRespondBodySchema,
  portalSubmitBodySchema,
  portalSubmitResultSchema,
  portalWithdrawBodySchema,
  requestIdSchema,
} from '@proton/module-applications/view';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { fetchGuildRoles, fetchUserGuilds } from '../lib/discord.ts';
import { getDiscordAccessToken, getDiscordUserId } from '../lib/discord-token.ts';
import { loadEnv } from '../lib/env.ts';
import { guildIconUrl } from '../lib/guild-access.ts';
import { requireSession } from '../middleware/guild-access.ts';
import { type ApiInit, apiQuery, rawApplicationsApi } from './applications-api.ts';
import { withAudit } from './audit.ts';

const env = loadEnv();

const formIdSchema = z.string().min(1).max(FORM_ID_MAX).regex(SLUG);
const applicationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export type ApplyRefusalKind =
  | 'not-member'
  | 'not-found'
  | 'off'
  | 'changed'
  | 'unavailable'
  | 'failed';

export interface ApplyRefusal {
  ok: false;
  kind: ApplyRefusalKind;
  message: string;
}

export type ApplyResult<T> = { ok: true; value: T } | ApplyRefusal;

export interface ApplyServer {
  id: string;
  name: string;
  iconUrl: string | null;
}

export interface MyApplicationsView {
  items: MyApplications['items'];
  servers: ApplyServer[] | null;
}

export interface ApplicationStatusView {
  application: PortalApplication;
  server: ApplyServer | null;
}

export type SaveDraftOutcome = DraftSaveResult | { status: 'failed'; message: string };
export type SubmitOutcome = PortalSubmitResult | { status: 'failed'; message: string };

const errorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});

const MACHINE_CODES: ReadonlySet<string> = new Set([
  'invalid_query',
  'invalid_body',
  'internal_error',
]);

const FALLBACK: Readonly<Record<ApplyRefusalKind, string>> = {
  'not-member': 'You need to be a member of this server to apply to its forms.',
  'not-found': 'Proton can’t find that. It may have been removed.',
  off: 'Applications is off in this server right now, so nothing was changed.',
  changed: 'This application changed since you opened it. Reload the page to see where it stands.',
  unavailable: 'Proton didn’t respond. Try again in a moment.',
  failed: 'Something went wrong on Proton’s side. Try again in a moment.',
};

const UNREADABLE = 'Proton sent an answer this page couldn’t read. Reload the page and try again.';

function refusalKind(status: number, code: string | undefined): ApplyRefusalKind {
  switch (code) {
    case 'not_member':
      return 'not-member';
    case 'not_found':
    case 'unknown_module':
      return 'not-found';
    case 'module_disabled':
      return 'off';
    case 'stale':
    case 'conflict':
      return 'changed';
    case 'unavailable':
    case 'no_bus':
    case 'no_redis':
      return 'unavailable';
  }

  if (status === 404) return 'not-found';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  return 'failed';
}

async function portal<S extends z.ZodType>(
  path: string,
  schema: S,
  init?: ApiInit,
): Promise<ApplyResult<z.output<S>>> {
  let response: Response;
  try {
    response = await rawApplicationsApi(path, init);
  } catch {
    return { ok: false, kind: 'unavailable', message: FALLBACK.unavailable };
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const refusal = errorBodySchema.safeParse(body);
    const code = refusal.success ? refusal.data.error : undefined;
    const said = refusal.success ? refusal.data.message : undefined;
    const kind = refusalKind(response.status, code);

    if (response.status >= 500 && kind === 'failed') {
      console.error(
        `the applications portal answered HTTP ${response.status} (${code ?? 'no code'})`,
      );
    }

    return {
      ok: false,
      kind,
      message:
        said !== undefined && said !== '' && (code === undefined || !MACHINE_CODES.has(code))
          ? said
          : FALLBACK[kind],
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    console.error(
      `the applications portal sent a reply the dashboard can’t read: ${parsed.error.issues
        .map((issue) => issue.path.join('.') || 'body')
        .join(', ')}`,
    );
    return { ok: false, kind: 'failed', message: UNREADABLE };
  }

  return { ok: true, value: parsed.data };
}

async function userServers(sessionUserId: string): Promise<ApplyServer[] | null> {
  try {
    const token = await getDiscordAccessToken(getRequest().headers, sessionUserId);
    const guilds = await fetchUserGuilds(env.REST_PROXY_URL, token);

    return guilds.map((guild) => ({
      id: guild.id,
      name: guild.name,
      iconUrl: guildIconUrl(guild),
    }));
  } catch {
    return null;
  }
}

const ROLE_MENTION = /<@&(\d{17,20})>/g;

async function namedRoles(guildId: string, form: PortalForm): Promise<PortalForm> {
  const lines = form.eligibility.lines;
  if (!lines.some((line) => line.text.includes('<@&'))) return form;

  let names: ReadonlyMap<string, string> | null = null;
  try {
    const roles = await fetchGuildRoles(env.REST_PROXY_URL, guildId);
    names = new Map(roles.map((role) => [role.id, role.name]));
  } catch {
    names = null;
  }

  // Discord itself shows a mention of a role that no longer exists as @deleted-role.
  const named = (text: string): string =>
    text.replace(ROLE_MENTION, (_, id: string) =>
      names === null ? '@role' : `@${names.get(id) ?? 'deleted-role'}`,
    );

  return {
    ...form,
    eligibility: {
      ...form.eligibility,
      lines: lines.map((line) => ({ ...line, text: named(line.text) })),
    },
  };
}

function saveOutcome<T extends { status: string }>(
  result: ApplyResult<T>,
): T | { status: 'failed'; message: string } | { status: 'refused'; message: string } {
  if (result.ok) return result.value;

  // Only an outage is worth asking again; any other refusal answers the same way every time.
  return result.kind === 'unavailable'
    ? { status: 'failed', message: result.message }
    : { status: 'refused', message: result.message };
}

export const listMyApplications = createServerFn({ method: 'GET' })
  .middleware([requireSession])
  .handler(async ({ context }): Promise<ApplyResult<MyApplicationsView>> => {
    const userId = await getDiscordUserId(context.session.user.id);

    const [mine, servers] = await Promise.all([
      portal(`/applicants/${userId}/applications`, myApplicationsSchema),
      userServers(context.session.user.id),
    ]);
    if (!mine.ok) return mine;

    return { ok: true, value: { items: mine.value.items, servers } };
  });

export const getApplyServerSchema = z.object({ guildId: snowflakeSchema });
export type GetApplyServerInput = z.input<typeof getApplyServerSchema>;

export const getApplyServer = createServerFn({ method: 'GET' })
  .middleware([requireSession])
  .validator(getApplyServerSchema)
  .handler(async ({ data, context }): Promise<ApplyResult<PortalGuild>> => {
    const userId = await getDiscordUserId(context.session.user.id);

    return portal(
      `/guilds/${data.guildId}/application-portal/forms${apiQuery({ userId })}`,
      portalGuildSchema,
    );
  });

export const getApplyFormSchema = z.object({ guildId: snowflakeSchema, formId: formIdSchema });
export type GetApplyFormInput = z.input<typeof getApplyFormSchema>;

export const getApplyForm = createServerFn({ method: 'GET' })
  .middleware([requireSession])
  .validator(getApplyFormSchema)
  .handler(async ({ data, context }): Promise<ApplyResult<PortalForm>> => {
    const userId = await getDiscordUserId(context.session.user.id);

    const result = await portal(
      `/guilds/${data.guildId}/application-portal/forms/${data.formId}${apiQuery({ userId })}`,
      portalFormSchema,
    );
    if (!result.ok) return result;

    return { ok: true, value: await namedRoles(data.guildId, result.value) };
  });

export const saveApplyDraftSchema = z.object({
  guildId: snowflakeSchema,
  formId: formIdSchema,
  answers: draftAnswersSchema,
  expectedRevision: z.number().int().min(0).nullable(),
  requestId: requestIdSchema,
  versionId: draftSaveBodySchema.shape.versionId,
});
export type SaveApplyDraftInput = z.input<typeof saveApplyDraftSchema>;

export const saveApplyDraft = createServerFn({ method: 'POST' })
  .middleware([requireSession])
  .validator(saveApplyDraftSchema)
  .handler(({ data, context }): Promise<SaveDraftOutcome> => {
    const { guildId, formId, answers, expectedRevision, requestId, versionId } = data;

    return withAudit(context.session.user.id, async (stamp) => {
      const body = draftSaveBodySchema.parse({
        answers,
        expectedRevision,
        requestId,
        userId: stamp.actorId,
        ...(versionId === undefined ? {} : { versionId }),
      });

      return saveOutcome(
        await portal(
          `/guilds/${guildId}/application-portal/forms/${formId}/draft`,
          draftSaveResultSchema,
          { method: 'POST', body: JSON.stringify(body) },
        ),
      );
    });
  });

export const submitApplyFormSchema = z.object({
  guildId: snowflakeSchema,
  formId: formIdSchema,
  expectedRevision: z.number().int().min(0),
  requestId: requestIdSchema,
});
export type SubmitApplyFormInput = z.input<typeof submitApplyFormSchema>;

export const submitApplyForm = createServerFn({ method: 'POST' })
  .middleware([requireSession])
  .validator(submitApplyFormSchema)
  .handler(({ data, context }): Promise<SubmitOutcome> => {
    const { guildId, formId, expectedRevision, requestId } = data;

    return withAudit(context.session.user.id, async (stamp) => {
      const body = portalSubmitBodySchema.parse({
        expectedRevision,
        requestId,
        userId: stamp.actorId,
      });

      return saveOutcome(
        await portal(
          `/guilds/${guildId}/application-portal/forms/${formId}/submit`,
          portalSubmitResultSchema,
          { method: 'POST', body: JSON.stringify(body) },
        ),
      );
    });
  });

export const discardApplyDraftSchema = z.object({
  guildId: snowflakeSchema,
  formId: formIdSchema,
  requestId: requestIdSchema,
});
export type DiscardApplyDraftInput = z.input<typeof discardApplyDraftSchema>;

export const discardApplyDraft = createServerFn({ method: 'POST' })
  .middleware([requireSession])
  .validator(discardApplyDraftSchema)
  .handler(({ data, context }): Promise<ApplyResult<PortalDiscardResult>> => {
    const { guildId, formId, requestId } = data;

    return withAudit(context.session.user.id, (stamp) => {
      const body = portalWithdrawBodySchema.parse({ requestId, userId: stamp.actorId });

      return portal(
        `/guilds/${guildId}/application-portal/forms/${formId}/discard`,
        portalDiscardResultSchema,
        { method: 'POST', body: JSON.stringify(body) },
      );
    });
  });

export const getApplicationStatusSchema = z.object({
  guildId: snowflakeSchema,
  applicationId: applicationIdSchema,
});
export type GetApplicationStatusInput = z.input<typeof getApplicationStatusSchema>;

export const getApplicationStatus = createServerFn({ method: 'GET' })
  .middleware([requireSession])
  .validator(getApplicationStatusSchema)
  .handler(async ({ data, context }): Promise<ApplyResult<ApplicationStatusView>> => {
    const userId = await getDiscordUserId(context.session.user.id);

    const [result, servers] = await Promise.all([
      portal(
        `/guilds/${data.guildId}/application-portal/applications/${data.applicationId}${apiQuery({
          userId,
        })}`,
        portalApplicationSchema,
      ),
      userServers(context.session.user.id),
    ]);
    if (!result.ok) return result;

    return {
      ok: true,
      value: {
        application: result.value,
        server: servers?.find((server) => server.id === data.guildId) ?? null,
      },
    };
  });

export const withdrawApplicationSchema = z.object({
  guildId: snowflakeSchema,
  applicationId: applicationIdSchema,
  requestId: requestIdSchema,
});
export type WithdrawApplicationInput = z.input<typeof withdrawApplicationSchema>;

export const withdrawApplication = createServerFn({ method: 'POST' })
  .middleware([requireSession])
  .validator(withdrawApplicationSchema)
  .handler(({ data, context }): Promise<ApplyResult<PortalApplication>> => {
    const { guildId, applicationId, requestId } = data;

    return withAudit(context.session.user.id, (stamp) => {
      const body = portalWithdrawBodySchema.parse({ requestId, userId: stamp.actorId });

      return portal(
        `/guilds/${guildId}/application-portal/applications/${applicationId}/withdraw`,
        portalApplicationSchema,
        { method: 'POST', body: JSON.stringify(body) },
      );
    });
  });

export const respondToApplicationSchema = z.object({
  guildId: snowflakeSchema,
  applicationId: applicationIdSchema,
  message: z.string().trim().min(1).max(INFO_RESPONSE_MAX),
  requestId: requestIdSchema,
});
export type RespondToApplicationInput = z.input<typeof respondToApplicationSchema>;

export const respondToApplication = createServerFn({ method: 'POST' })
  .middleware([requireSession])
  .validator(respondToApplicationSchema)
  .handler(({ data, context }): Promise<ApplyResult<PortalApplication>> => {
    const { guildId, applicationId, message, requestId } = data;

    return withAudit(context.session.user.id, (stamp) => {
      const body = portalRespondBodySchema.parse({ message, requestId, userId: stamp.actorId });

      return portal(
        `/guilds/${guildId}/application-portal/applications/${applicationId}/respond`,
        portalApplicationSchema,
        { method: 'POST', body: JSON.stringify(body) },
      );
    });
  });
