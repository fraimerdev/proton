import { snowflakeSchema } from '@proton/core';
import { FORM_ID_MAX } from '@proton/module-applications/constants';
import {
  audienceSchema,
  eligibilityPreviewSchema,
  formOverviewSchema,
  type PublishResult,
  publishBodySchema,
  publishResultSchema,
  versionListSchema,
  versionSchema,
} from '@proton/module-applications/view';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireGuildAccess, requireManageGuild } from '../middleware/guild-access.ts';
import { apiQuery, callApplicationsApi, rawApplicationsApi } from './applications-api.ts';
import { withAudit } from './audit.ts';

const guildIdSchema = z.string().min(1);
const formIdSchema = z.string().min(1).max(FORM_ID_MAX);
const versionIdSchema = z.string().min(1).max(64);

const apiMessageSchema = z.object({ message: z.string() });

function formsPath(guildId: string): string {
  return `/guilds/${encodeURIComponent(guildId)}/applications/forms`;
}

function formPath(guildId: string, formId: string): string {
  return `${formsPath(guildId)}/${encodeURIComponent(formId)}`;
}

export type PublishOutcome = { ok: true; result: PublishResult } | { ok: false; message: string };

async function publishOutcome(path: string, body: unknown): Promise<PublishOutcome> {
  const response = await rawApplicationsApi(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const answer: unknown = await response.json().catch(() => null);

  if (response.ok) {
    const parsed = publishResultSchema.safeParse(answer);
    if (parsed.success) return { ok: true, result: parsed.data };

    throw new Error(
      'Proton published the form, but its answer couldn’t be read. Reload the page to see the ' +
        'new version.',
    );
  }

  const refusal = apiMessageSchema.safeParse(answer);

  if (response.status >= 400 && response.status < 500 && refusal.success) {
    return { ok: false, message: refusal.data.message };
  }

  throw new Error(
    refusal.success
      ? refusal.data.message
      : `Proton's API did not answer (HTTP ${response.status}). Nothing was changed. Try again ` +
          'in a moment.',
  );
}

export const getApplicationForms = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(z.object({ guildId: guildIdSchema }))
  .handler(({ data }) => callApplicationsApi(formsPath(data.guildId), formOverviewSchema));

const publishInputSchema = publishBodySchema
  .pick({ requestId: true, draftPolicy: true })
  .extend({ guildId: guildIdSchema, formId: formIdSchema });

export type PublishApplicationFormInput = z.input<typeof publishInputSchema>;

export const publishApplicationForm = createServerFn({ method: 'POST' })
  .middleware([requireManageGuild])
  .validator(publishInputSchema)
  .handler(({ data, context }) => {
    const { guildId, formId, ...body } = data;
    return withAudit(context.session.user.id, (stamp) =>
      publishOutcome(`${formPath(guildId, formId)}/publish`, { ...body, ...stamp }),
    );
  });

const versionsInputSchema = z.object({ guildId: guildIdSchema, formId: formIdSchema });

export type ApplicationFormVersionsInput = z.input<typeof versionsInputSchema>;

export const getApplicationFormVersions = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(versionsInputSchema)
  .handler(({ data }) =>
    callApplicationsApi(`${formPath(data.guildId, data.formId)}/versions`, versionListSchema),
  );

const versionInputSchema = versionsInputSchema.extend({ versionId: versionIdSchema });

export type ApplicationFormVersionInput = z.input<typeof versionInputSchema>;

export const getApplicationFormVersion = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(versionInputSchema)
  .handler(({ data }) =>
    callApplicationsApi(
      `${formPath(data.guildId, data.formId)}/versions/${encodeURIComponent(data.versionId)}`,
      versionSchema,
    ),
  );

// userId is the member being previewed, picked by the admin; the admin's own id never leaves here.
const eligibilityInputSchema = versionsInputSchema.extend({ userId: snowflakeSchema });

export type EligibilityPreviewInput = z.input<typeof eligibilityInputSchema>;

export const previewApplicationEligibility = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(eligibilityInputSchema)
  .handler(({ data }) =>
    callApplicationsApi(
      `${formPath(data.guildId, data.formId)}/eligibility${apiQuery({ userId: data.userId })}`,
      eligibilityPreviewSchema,
    ),
  );

const audienceInputSchema = z.object({
  guildId: guildIdSchema,
  channelId: snowflakeSchema,
  formId: formIdSchema.optional(),
});

export type ReviewAudienceInput = z.input<typeof audienceInputSchema>;

export const getReviewAudience = createServerFn({ method: 'GET' })
  .middleware([requireGuildAccess])
  .validator(audienceInputSchema)
  .handler(({ data }) =>
    callApplicationsApi(
      `/guilds/${encodeURIComponent(data.guildId)}/applications/audience/` +
        `${encodeURIComponent(data.channelId)}${apiQuery({ formId: data.formId })}`,
      audienceSchema,
    ),
  );
