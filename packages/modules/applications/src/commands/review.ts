import {
  type CommandContext,
  type CommandDefinition,
  deferEphemeral,
  errorStatus,
  type FollowUpTo,
  type InteractionMessage,
  labelOf,
  type RespondTo,
  replyEphemeral,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { ButtonStyle, ComponentType, InteractionContextType } from 'discord-api-types/v10';
import { type ReviewActor, viewableFormIds } from '../authorize.ts';
import { actorMention, cardMessage, clip, plain, relative, reviewUrl } from '../card.ts';
import { type ApplicationsConfig, formFor } from '../config.ts';
import { MODULE_ID } from '../constants.ts';
import {
  type ApplicationsDeps,
  type BoundApplicationsDeps,
  bindApplicationsDeps,
  describeUnbound,
} from '../deps.ts';
import { CustomIdTooLongError, customId, STAFF_ACTION } from '../interface.ts';
import {
  loadForView,
  mayViewAny,
  notOpenable,
  privateCard,
  respond,
  settle,
  statusMessage,
} from '../staff.ts';
import type { ApplicationRecord } from '../store.ts';
import { type QueueSummary, queueQuerySchema } from '../view.ts';
import { referenceOf } from '../web.ts';

type Ctx = CommandContext<ApplicationsConfig>;
type Component = Record<string, unknown>;

export const QUEUE_SHOWN = 5;

const NAME = 'applications';
const DESCRIPTION = 'See the applications waiting for review, or open one by its number.';
const ACCENT = 0x2a8af7;
const FORM_SHOWN_MAX = 60;

const NOT_WIRED =
  'I can’t reach this server’s applications right now, so nothing was shown. This is a fault on ' +
  'my side, not a setting in this server.';
const MODULE_OFF =
  'Applications is off in this server. A server admin can turn it on in the dashboard.';
const NO_TEAM = 'You aren’t on the review team for any application form in this server.';
const NUMBER_MAX = 2_147_483_647;

export function commandActor(ctx: Ctx): ReviewActor {
  return {
    id: ctx.userId,
    roleIds: ctx.actorRoleIds ?? [],
    permissions: ctx.actorPermissions ?? 0n,
    owner: false,
  };
}

function builder(): SlashCommandBuilder {
  const command = new SlashCommandBuilder()
    .setName(NAME)
    .setDescription(DESCRIPTION)
    .setContexts(InteractionContextType.Guild);

  command.addSubcommand((sub) =>
    sub.setName('queue').setDescription('See how many applications are waiting for review.'),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription('Open an application by its number.')
      .addIntegerOption((option) =>
        option
          .setName('number')
          .setDescription('The application’s number, like 12.')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(NUMBER_MAX),
      ),
  );

  return command;
}

function text(content: string): Component {
  return { type: ComponentType.TextDisplay, content };
}

function separator(): Component {
  return { type: ComponentType.Separator, divider: true, spacing: 1 };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function countsLine(summary: QueueSummary): string {
  return [
    `**${summary.awaiting}** waiting for review`,
    `${summary.unassigned} not claimed`,
    `${summary.needsInfo} waiting on the applicant`,
    `${summary.waitlisted} waitlisted`,
  ].join(' · ');
}

function itemSection(config: ApplicationsConfig, item: ApplicationRecord): Component {
  const formName = formFor(config, item.formId)?.name ?? item.formId;
  const name = item.applicantName?.trim();
  const who = name
    ? `${actorMention(item.applicantId)} · ${plain(clip(name, 40))}`
    : actorMention(item.applicantId);

  const detail = [who];
  if (item.submittedAt !== null) detail.push(`sent ${relative(item.submittedAt)}`);
  if (item.assigneeId !== null) detail.push(`claimed by ${actorMention(item.assigneeId)}`);

  return {
    type: ComponentType.Section,
    components: [
      text(
        `**${referenceOf(item.number)}** · ${clip(formName, FORM_SHOWN_MAX)}\n${detail.join(' · ')}`,
      ),
    ],
    accessory: {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      label: 'View',
      custom_id: customId(STAFF_ACTION.card, item.id),
    },
  };
}

export function queueScreen(input: {
  ctx: Pick<Ctx, 'config' | 'guildId' | 'commandLabel'>;
  summary: QueueSummary;
  waiting: readonly ApplicationRecord[];
  total: number;
  dashboardUrl: string | null;
}): Component[] {
  const { ctx, summary, waiting, dashboardUrl } = input;

  const head = [`## Applications`, countsLine(summary)];
  if (summary.oldestAwaitingAt !== null) {
    head.push(`The oldest has waited since ${relative(summary.oldestAwaitingAt)}.`);
  }
  if (summary.problems > 0) {
    head.push(
      `${plural(summary.problems, 'application')} ${summary.problems === 1 ? 'has' : 'have'} ` +
        'an action that failed. Retry it from the dashboard.',
    );
  }

  const children: Component[] = [text(head.join('\n')), separator()];

  if (waiting.length === 0) {
    children.push(text('Nothing is waiting for review.'));
  } else {
    const shown =
      input.total > waiting.length
        ? `-# The ${waiting.length} that have waited longest.`
        : '-# Waiting the longest first.';
    children.push(text(shown));
    for (const item of waiting) children.push(itemSection(ctx.config, item));
  }

  children.push(
    text(`-# Open any application with \`${labelOf(ctx, NAME, 'view')}\` and its number.`),
  );

  if (dashboardUrl !== null) {
    children.push(separator(), {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: 'Open the review queue',
          url: reviewUrl(dashboardUrl, ctx.guildId),
        },
      ],
    });
  }

  return [{ type: ComponentType.Container, accent_color: ACCENT, components: children }];
}

async function queueMessage(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  actor: ReviewActor,
): Promise<InteractionMessage> {
  const { config } = ctx;
  if (config.forms.length === 0) {
    return statusMessage(
      errorStatus(
        'This server has no application forms yet. A server admin can add one in the dashboard.',
      ),
    );
  }

  const formIds = viewableFormIds(config, actor);
  if (formIds.length === 0) return statusMessage(errorStatus(NO_TEAM));

  const query = queueQuerySchema.parse({
    view: 'awaiting',
    sort: 'submitted',
    dir: 'asc',
    pageSize: QUEUE_SHOWN,
  });
  const [summary, waiting] = await Promise.all([
    deps.store.summary(ctx.guildId, formIds, actor.id),
    deps.store.list(ctx.guildId, { ...query, formIds, viewerId: actor.id }),
  ]);

  return cardMessage(
    queueScreen({
      ctx,
      summary,
      waiting: waiting.items,
      total: waiting.total,
      dashboardUrl: deps.dashboardUrl,
    }),
  );
}

async function viewMessage(
  ctx: Ctx,
  deps: BoundApplicationsDeps,
  actor: ReviewActor,
): Promise<InteractionMessage> {
  const number = ctx.options.getInteger('number');
  if (number === null || number < 1) {
    return statusMessage(errorStatus('Give the application’s number, like 12.'));
  }
  if (!mayViewAny(ctx.config, actor)) return statusMessage(errorStatus(NO_TEAM));

  const hidden = statusMessage(errorStatus(notOpenable(number)));
  if (number > NUMBER_MAX) return hidden;

  const application = await deps.store.byNumber(ctx.guildId, number);
  if (application === null) return hidden;

  const loaded = await loadForView(ctx, deps, actor, application.id);
  if (!loaded.ok) return loaded.hidden ? hidden : statusMessage(errorStatus(loaded.humanReason));

  return privateCard(ctx, deps, loaded.value);
}

async function run(ctx: Ctx, deps: ApplicationsDeps): Promise<void> {
  const to: RespondTo = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: ctx.interaction,
    idempotencyKey: ctx.idempotencyKey,
  };

  const bound = bindApplicationsDeps(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound(`/${NAME}`, bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    await respond(ctx, replyEphemeral(to, statusMessage(errorStatus(NOT_WIRED))));
    return;
  }

  if (!ctx.config.enabled) {
    await respond(ctx, replyEphemeral(to, statusMessage(errorStatus(MODULE_OFF))));
    return;
  }

  const follow: FollowUpTo = {
    ...to,
    applicationId: ctx.applicationId ?? bound.deps.applicationId,
  };
  await respond(ctx, deferEphemeral(to));

  const actor = commandActor(ctx);
  let message: InteractionMessage;
  try {
    message =
      ctx.options.getSubcommand() === 'view'
        ? await viewMessage(ctx, bound.deps, actor)
        : await queueMessage(ctx, bound.deps, actor);
  } catch (error) {
    if (!(error instanceof CustomIdTooLongError)) throw error;
    message = statusMessage(errorStatus(error.message));
  }

  await settle(ctx, follow, message);
}

export function applicationsCommand(deps: ApplicationsDeps): CommandDefinition<ApplicationsConfig> {
  return {
    name: NAME,
    description: DESCRIPTION,
    data: builder().toJSON(),
    handler: (ctx) => run(ctx, deps),
  };
}
