import {
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  type CommandDefinition,
  deferEphemeral,
  editOriginal,
  errorStatus,
  type FollowUpTo,
  followUp,
  type InteractionMessage,
  labelOf,
  type RespondTo,
  replyEphemeral,
} from '@proton/core';
import { SlashCommandBuilder } from 'discord.js';
import { InteractionContextType, InteractionType } from 'discord-api-types/v10';
import { APPLICATION_OPTION, APPLY_COMMAND, FORM_OPTION } from '../autocomplete.ts';
import { type ApplicationsConfig, formFor } from '../config.ts';
import { MODULE_ID } from '../constants.ts';
import {
  type ApplicationsDeps,
  type BoundApplicationsDeps,
  bindApplicationsDeps,
  describeUnbound,
} from '../deps.ts';
import { mineEntries, mineLink, offSentence, overviewFor, statusMessage } from '../flow.ts';
import { commandMemberContext } from '../member.ts';
import {
  type Component,
  mineScreen,
  v2Message,
  viewButton,
  withdrawConfirmScreen,
} from '../overview.ts';
import { STATUS_LABELS } from '../status.ts';
import type { ApplicationRecord } from '../store.ts';
import { canWithdraw } from '../web.ts';

type Command = CommandDefinition<ApplicationsConfig>;
type Context = CommandContext<ApplicationsConfig>;

const DESCRIPTION = 'Apply to this server’s forms and check on your applications.';
const OPTION_MAX = 100;
const ANSWER = 'answer';
const APPLICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REFERENCE = /^#?(\d{1,9})$/;

const NOT_WIRED =
  'I can’t reach this server’s applications right now, so nothing was changed. This is a fault ' +
  'on my side, not a setting in this server.';

function builder(): SlashCommandBuilder {
  const command = new SlashCommandBuilder()
    .setName(APPLY_COMMAND)
    .setDescription(DESCRIPTION)
    .setContexts(InteractionContextType.Guild);

  command.addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('See what a form asks and whether you can apply, then start or continue.')
      .addStringOption((option) =>
        option
          .setName(FORM_OPTION)
          .setDescription('The form to apply to.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(OPTION_MAX),
      ),
  );

  command.addSubcommand((sub) =>
    sub.setName('status').setDescription('See your applications in this server and their status.'),
  );

  command.addSubcommand((sub) =>
    sub.setName('resume').setDescription('Continue an application you saved for later.'),
  );

  command.addSubcommand((sub) =>
    sub
      .setName('withdraw')
      .setDescription('Withdraw an application that hasn’t been decided yet.')
      .addStringOption((option) =>
        option
          .setName(APPLICATION_OPTION)
          .setDescription('The application to withdraw.')
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(OPTION_MAX),
      ),
  );

  return command;
}

interface Invocation {
  ctx: Context;
  deps: BoundApplicationsDeps;
  follow: FollowUpTo;
  now: number;
}

function failed(result: ActionResult): boolean {
  return result.status === 'failed_precheck' || result.status === 'failed_api';
}

async function run(ctx: Context, request: ActionRequest): Promise<ActionResult> {
  const result = await ctx.executor.execute(request);
  if (failed(result)) {
    ctx.logger.warn(
      `applications could not answer /${APPLY_COMMAND}: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
  return result;
}

async function say(invocation: Invocation, message: InteractionMessage): Promise<void> {
  const edited = await invocation.ctx.executor.execute(
    editOriginal(invocation.follow, message, ANSWER),
  );
  if (!failed(edited)) return;

  await run(invocation.ctx, followUp(invocation.follow, { ...message, ephemeral: true }, ANSWER));
}

function show(invocation: Invocation, components: Component[]): Promise<void> {
  return say(invocation, v2Message(components));
}

function refuse(
  invocation: Invocation,
  sentence: string,
  buttons: readonly Component[] = [],
): Promise<void> {
  return say(invocation, statusMessage(errorStatus(sentence), buttons));
}

function resolveFormId(config: ApplicationsConfig, raw: string): string | null {
  const wanted = raw.trim();
  if (formFor(config, wanted) !== undefined) return wanted;

  const lowered = wanted.toLowerCase();
  return config.forms.find((form) => form.name.toLowerCase() === lowered)?.id ?? null;
}

async function start(invocation: Invocation): Promise<void> {
  const { ctx, deps, now } = invocation;
  const raw = ctx.options.getString(FORM_OPTION) ?? '';
  const formId = resolveFormId(ctx.config, raw);

  if (formId === null) {
    await refuse(
      invocation,
      `There’s no form called **${raw.slice(0, OPTION_MAX)}** in this server. Pick one from the list as you type.`,
    );
    return;
  }

  const overview = await overviewFor({
    ctx,
    deps,
    userId: ctx.userId,
    formId,
    member: commandMemberContext(ctx, now),
    now,
  });

  if (!overview.ok) {
    await refuse(invocation, overview.humanReason);
    return;
  }
  await show(invocation, overview.components);
}

async function status(invocation: Invocation, draftsOnly: boolean): Promise<void> {
  const { ctx, deps } = invocation;
  const rows = await deps.store.mine(ctx.guildId, ctx.userId);
  const entries = mineEntries(ctx.config, rows).filter(
    (entry) => !draftsOnly || entry.status === 'draft',
  );

  await show(
    invocation,
    mineScreen({
      title: draftsOnly ? 'Your saved applications' : 'Your applications',
      empty: draftsOnly
        ? `You have no saved applications in this server. Start one with \`${labelOf(ctx, APPLY_COMMAND, 'start')}\`.`
        : `You haven’t applied to anything in this server yet. Start with \`${labelOf(ctx, APPLY_COMMAND, 'start')}\`.`,
      entries,
      link: mineLink(deps, ctx.guildId),
    }),
  );
}

async function findOwn(invocation: Invocation, raw: string): Promise<ApplicationRecord | null> {
  const { ctx, deps } = invocation;
  const wanted = raw.trim();

  const reference = REFERENCE.exec(wanted);
  const found =
    reference?.[1] !== undefined
      ? await deps.store.byNumber(ctx.guildId, Number(reference[1]))
      : APPLICATION_ID.test(wanted)
        ? await deps.store.get(ctx.guildId, wanted)
        : null;

  if (found === null || found.deletedAt !== null || found.applicantId !== ctx.userId) return null;
  return found;
}

async function withdraw(invocation: Invocation): Promise<void> {
  const { ctx, deps } = invocation;
  const raw = ctx.options.getString(APPLICATION_OPTION) ?? '';
  const application = await findOwn(invocation, raw);

  if (application === null || application.number === null) {
    await refuse(
      invocation,
      `I can’t find an application of yours called **${raw.slice(0, OPTION_MAX)}**. Pick one from the list as you type.`,
    );
    return;
  }

  if (!canWithdraw(application.status)) {
    await refuse(
      invocation,
      `This application is ${STATUS_LABELS[application.status].toLowerCase()}, so it can’t be withdrawn.`,
      [viewButton(application.id)],
    );
    return;
  }

  const version = await deps.store.version(ctx.guildId, application.versionId);
  await show(
    invocation,
    withdrawConfirmScreen({
      applicationId: application.id,
      formName:
        version?.snapshot.name ??
        formFor(ctx.config, application.formId)?.name ??
        application.formId,
      number: application.number,
    }),
  );
}

export function applyCommand(deps: ApplicationsDeps): Command {
  return {
    name: APPLY_COMMAND,
    description: DESCRIPTION,
    data: builder().toJSON(),

    async handler(ctx) {
      const to: RespondTo = {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        actorId: ctx.userId,
        interaction: { ...ctx.interaction, type: InteractionType.ApplicationCommand },
        idempotencyKey: ctx.idempotencyKey,
      };

      if (!ctx.config.enabled) {
        const off = offSentence(
          ctx.guildId,
          deps.dashboardUrl,
          `\`${labelOf(ctx, APPLY_COMMAND)}\` can’t run`,
        );
        await run(ctx, replyEphemeral(to, errorStatus(off)));
        return;
      }

      const bound = bindApplicationsDeps(deps);
      if ('unbound' in bound) {
        ctx.logger.error(describeUnbound(`/${APPLY_COMMAND} is NOT running`, bound.unbound), {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
        await run(ctx, replyEphemeral(to, errorStatus(NOT_WIRED)));
        return;
      }

      await run(ctx, deferEphemeral(to));

      const invocation: Invocation = {
        ctx,
        deps: bound.deps,
        follow: { ...to, applicationId: ctx.applicationId ?? bound.deps.applicationId },
        now: bound.deps.now(),
      };

      switch (ctx.options.getSubcommand()) {
        case 'start':
          return start(invocation);
        case 'status':
          return status(invocation, false);
        case 'resume':
          return status(invocation, true);
        case 'withdraw':
          return withdraw(invocation);
        default:
          await refuse(
            invocation,
            `That part of \`/${APPLY_COMMAND}\` no longer exists. Run the command again.`,
          );
      }
    },
  };
}
