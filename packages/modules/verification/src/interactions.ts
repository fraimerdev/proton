import {
  type Attachment,
  deferEphemeral,
  type FollowUpTo,
  followUp,
  interactionRef,
  type ModuleContext,
  newVerifyLinkClaims,
  openModal,
  type ProtonEvent,
  parseCustomId,
  type RespondTo,
  readComponentInteraction,
  readModalInteraction,
  replyEphemeral,
  signVerifyLink,
} from '@proton/core';
import { answerMatches, challengeTtlMs, newChallenge } from './challenge.ts';
import type { VerificationConfig } from './config.ts';
import {
  type BoundCaptchaDeps,
  bindCaptchaDeps,
  bindPressDeps,
  bindWebsiteDeps,
  describeUnbound,
  type VerificationDeps,
} from './deps.ts';
import { planFailure } from './failure.ts';
import { planVerification, runVerification } from './gate.ts';
import {
  ANSWER_ACTION,
  buildCaptchaMessage,
  buildCaptchaModal,
  buildWebsiteMessage,
  CAPTCHA_ACTION,
  CODE_FIELD,
  REFRESH_ACTION,
  VERIFY_ACTION,
} from './panel.ts';
import { followUpTo, MODULE_ID, respondTo, run, succeeded, VERIFICATION_ACTOR } from './perform.ts';
import type { CaptchaChallenge } from './store.ts';

const SWITCHED_OFF =
  'Verification is switched off in this server, so there is nothing to pass. An admin can turn ' +
  'it on from the Proton dashboard.';

const NOT_WIRED =
  "I can't verify you: this Proton deployment isn't fully set up. A server admin should check " +
  'the Proton logs — the exact missing piece is named there.';

const EXPIRED = 'That captcha has expired or been replaced. Press Verify again to get a fresh one.';

const WRONG = 'That is not the code in the image.';

export type InteractionOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'challenged'; challengeId: string }
  | { action: 'linked' }
  | { action: 'verified' }
  | { action: 'failed'; attemptsUsed: number };

export async function handleComponent(
  event: ProtonEvent,
  ctx: ModuleContext<VerificationConfig>,
  deps: VerificationDeps,
): Promise<InteractionOutcome> {
  const facts = readComponentInteraction(event);
  if (!facts) {
    ctx.logger.error(
      'verification received an interaction.component it could not read, so whoever pressed it ' +
        'was left with a failed interaction. This is a gateway/normaliser mismatch.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
    );
    return { action: 'ignored', reason: 'unreadable interaction payload' };
  }

  const parsed = parseCustomId(facts.customId);
  if (!parsed || parsed.moduleId !== MODULE_ID) {
    return { action: 'ignored', reason: 'another module owns that component' };
  }

  const to = respondTo(ctx, interactionRef(facts), facts.userId, event.id);

  if (!ctx.config.enabled) {
    await run(ctx, replyEphemeral(to, SWITCHED_OFF), 'answer a press while switched off');
    return { action: 'refused', reason: 'verification is off in this server' };
  }

  switch (parsed.action) {
    case VERIFY_ACTION:
      return startVerification(ctx, deps, to, facts.userId, facts.roleIds, event.id);

    case CAPTCHA_ACTION:
      return openAnswerModal(ctx, deps, to, facts.userId, parsed.args[0]);

    case REFRESH_ACTION:
      return reissueChallenge(ctx, deps, to, facts.userId, parsed.args[0]);

    default:
      return { action: 'ignored', reason: `no verification component called '${parsed.action}'` };
  }
}

async function startVerification(
  ctx: ModuleContext<VerificationConfig>,
  deps: VerificationDeps,
  to: RespondTo,
  userId: string,
  roleIds: string[] | null,
  eventId: string,
): Promise<InteractionOutcome> {
  const verifiedRoleId = ctx.config.verifiedRoleId;
  if (verifiedRoleId && roleIds?.includes(verifiedRoleId)) {
    await run(
      ctx,
      replyEphemeral(to, "You're already verified — you have full access to this server."),
      'tell a verified member they are verified',
    );
    return { action: 'refused', reason: 'the member already holds the member role' };
  }

  switch (ctx.config.mode) {
    case 'button':
      return pressButton(ctx, deps, to, userId, eventId);

    case 'captcha':
      return pressCaptcha(ctx, deps, to, userId, eventId);

    case 'website':
      return pressWebsite(ctx, deps, to, userId);
  }
}

async function pressButton(
  ctx: ModuleContext<VerificationConfig>,
  deps: VerificationDeps,
  to: RespondTo,
  userId: string,
  eventId: string,
): Promise<InteractionOutcome> {
  const bound = bindPressDeps(deps);
  if ('unbound' in bound) return notWired(ctx, to, bound.unbound);

  const followTo = followUpTo(to, bound.deps.applicationId);
  await run(ctx, deferEphemeral(to), 'acknowledge the press');

  const plan = planVerification(ctx.config, await bound.deps.guildState.get(ctx.guildId));
  if ('refusal' in plan) {
    await run(ctx, followUp(followTo, plan.refusal), 'explain why the gate could not be passed');
    return { action: 'refused', reason: plan.refusal };
  }

  const result = await runVerification(ctx, plan, userId, eventId);
  await run(ctx, followUp(followTo, result.message), 'tell the member how verification went');

  return result.verified ? { action: 'verified' } : { action: 'refused', reason: result.message };
}

async function pressCaptcha(
  ctx: ModuleContext<VerificationConfig>,
  deps: VerificationDeps,
  to: RespondTo,
  userId: string,
  eventId: string,
): Promise<InteractionOutcome> {
  const bound = bindCaptchaDeps(deps);
  if ('unbound' in bound) return notWired(ctx, to, bound.unbound);

  const followTo = followUpTo(to, bound.deps.applicationId);
  await run(ctx, deferEphemeral(to), 'acknowledge the press');

  // Checked before the member is made to solve anything: a captcha Proton cannot reward is worse
  // than an honest refusal.
  const plan = planVerification(ctx.config, await bound.deps.guildState.get(ctx.guildId));
  if ('refusal' in plan) {
    await run(ctx, followUp(followTo, plan.refusal), 'explain why the gate could not be passed');
    return { action: 'refused', reason: plan.refusal };
  }

  const challenge = newChallenge(ctx.guildId, userId, ctx.config.captchaLength, bound.deps.now());

  const issued = await issue(ctx, bound.deps, challenge);
  if (!issued) {
    await run(
      ctx,
      followUp(
        followTo,
        'I could not draw your captcha, so nothing has changed. Try again in a moment — if it ' +
          'keeps happening, tell a moderator.',
      ),
      'apologise for a failed captcha render',
    );
    return { action: 'refused', reason: 'the captcha could not be issued' };
  }

  await bound.deps.captcha.put(challenge, challengeTtlMs(ctx.config));

  if (ctx.config.captchaDelivery === 'dm') {
    const delivered = await deliverByDm(ctx, followTo, userId, eventId, issued);
    if (delivered) return { action: 'challenged', challengeId: challenge.challengeId };
  }

  await run(ctx, followUp(followTo, issued), 'send the captcha');
  return { action: 'challenged', challengeId: challenge.challengeId };
}

async function pressWebsite(
  ctx: ModuleContext<VerificationConfig>,
  deps: VerificationDeps,
  to: RespondTo,
  userId: string,
): Promise<InteractionOutcome> {
  const bound = bindWebsiteDeps(deps);
  if ('unbound' in bound) return notWired(ctx, to, bound.unbound);

  const followTo = followUpTo(to, bound.deps.applicationId);
  await run(ctx, deferEphemeral(to), 'acknowledge the press');

  const plan = planVerification(ctx.config, await bound.deps.guildState.get(ctx.guildId));
  if ('refusal' in plan) {
    await run(ctx, followUp(followTo, plan.refusal), 'explain why the gate could not be passed');
    return { action: 'refused', reason: plan.refusal };
  }

  const claims = newVerifyLinkClaims(ctx.guildId, userId, bound.deps.now());
  const token = await signVerifyLink(claims, bound.deps.verifyLinkSecret);
  const built = buildWebsiteMessage(
    `${bound.deps.verifyLinkBaseUrl.replace(/\/+$/, '')}/verify/${token}`,
    ctx.config.panelButtonLabel,
  );

  await run(
    ctx,
    followUp(followTo, { content: built.content, components: built.components }),
    'send the verification link',
  );

  return { action: 'linked' };
}

async function openAnswerModal(
  ctx: ModuleContext<VerificationConfig>,
  deps: VerificationDeps,
  to: RespondTo,
  userId: string,
  challengeId: string | undefined,
): Promise<InteractionOutcome> {
  const bound = bindCaptchaDeps(deps);
  if ('unbound' in bound) return notWired(ctx, to, bound.unbound);

  const challenge = await bound.deps.captcha.get(ctx.guildId, userId);
  if (!challenge || challenge.challengeId !== challengeId) {
    await run(ctx, replyEphemeral(to, EXPIRED), 'tell the member their captcha expired');
    return { action: 'refused', reason: 'the challenge is gone or has been replaced' };
  }

  const modal = buildCaptchaModal(challenge.challengeId, challenge.answer.length);
  if (!modal) {
    await run(ctx, replyEphemeral(to, NOT_WIRED), 'apologise for an unbuildable captcha modal');
    return { action: 'refused', reason: 'the captcha modal custom_id did not fit' };
  }

  // Opening a modal IS the three-second acknowledgement, so nothing above this may defer first.
  await run(ctx, openModal(to, modal), 'open the captcha modal');
  return { action: 'challenged', challengeId: challenge.challengeId };
}

async function reissueChallenge(
  ctx: ModuleContext<VerificationConfig>,
  deps: VerificationDeps,
  to: RespondTo,
  userId: string,
  challengeId: string | undefined,
): Promise<InteractionOutcome> {
  const bound = bindCaptchaDeps(deps);
  if ('unbound' in bound) return notWired(ctx, to, bound.unbound);

  const current = await bound.deps.captcha.get(ctx.guildId, userId);
  if (!current || current.challengeId !== challengeId) {
    await run(ctx, replyEphemeral(to, EXPIRED), 'tell the member their captcha expired');
    return { action: 'refused', reason: 'the challenge is gone or has been replaced' };
  }

  const replacement = newChallenge(
    ctx.guildId,
    userId,
    ctx.config.captchaLength,
    bound.deps.now(),
    current.attemptsUsed,
  );

  const issued = await issue(ctx, bound.deps, replacement);
  if (!issued) {
    await run(ctx, replyEphemeral(to, EXPIRED), 'apologise for a failed captcha render');
    return { action: 'refused', reason: 'the replacement captcha could not be issued' };
  }

  // A different picture, not a fresh deadline and not a fresh attempt budget.
  await bound.deps.captcha.update(replacement);

  await run(ctx, replyEphemeral(to, issued), 'send a different captcha');
  return { action: 'challenged', challengeId: replacement.challengeId };
}

export async function handleModal(
  event: ProtonEvent,
  ctx: ModuleContext<VerificationConfig>,
  deps: VerificationDeps,
): Promise<InteractionOutcome> {
  const facts = readModalInteraction(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable interaction payload' };

  const parsed = parseCustomId(facts.customId);
  if (!parsed || parsed.moduleId !== MODULE_ID) {
    return { action: 'ignored', reason: 'another module owns that modal' };
  }
  if (parsed.action !== ANSWER_ACTION) {
    return { action: 'ignored', reason: `no verification modal called '${parsed.action}'` };
  }

  const to = respondTo(ctx, interactionRef(facts), facts.userId, event.id);

  if (!ctx.config.enabled) {
    await run(ctx, replyEphemeral(to, SWITCHED_OFF), 'answer a modal while switched off');
    return { action: 'refused', reason: 'verification is off in this server' };
  }

  const bound = bindCaptchaDeps(deps);
  if ('unbound' in bound) return notWired(ctx, to, bound.unbound);

  const challenge = await bound.deps.captcha.get(ctx.guildId, facts.userId);
  if (!challenge || challenge.challengeId !== parsed.args[0]) {
    await run(ctx, replyEphemeral(to, EXPIRED), 'tell the member their captcha expired');
    return { action: 'refused', reason: 'the challenge is gone or has been replaced' };
  }

  if (!answerMatches(challenge, facts.fields[CODE_FIELD] ?? '')) {
    return rejectAnswer(ctx, bound.deps, to, challenge, event.id);
  }

  const followTo = followUpTo(to, bound.deps.applicationId);
  await run(ctx, deferEphemeral(to), 'acknowledge the answer');
  await bound.deps.captcha.clear(ctx.guildId, facts.userId);

  const plan = planVerification(ctx.config, await bound.deps.guildState.get(ctx.guildId));
  if ('refusal' in plan) {
    await run(ctx, followUp(followTo, plan.refusal), 'explain why the gate could not be passed');
    return { action: 'refused', reason: plan.refusal };
  }

  const result = await runVerification(ctx, plan, facts.userId, event.id);
  await run(ctx, followUp(followTo, result.message), 'tell the member how verification went');

  return result.verified ? { action: 'verified' } : { action: 'refused', reason: result.message };
}

async function rejectAnswer(
  ctx: ModuleContext<VerificationConfig>,
  deps: BoundCaptchaDeps,
  to: RespondTo,
  challenge: CaptchaChallenge,
  eventId: string,
): Promise<InteractionOutcome> {
  const attemptsUsed = challenge.attemptsUsed + 1;
  const attemptsLeft = ctx.config.captchaAttempts - attemptsUsed;

  if (attemptsLeft > 0) {
    await deps.captcha.update({ ...challenge, attemptsUsed });

    const built = buildCaptchaMessage(challenge.challengeId, attemptsLeft - 1);
    const retry = built.ok
      ? { content: `${WRONG} ${built.content}`, components: built.components }
      : { content: `${WRONG} Press Verify again to start over.` };

    await run(ctx, replyEphemeral(to, retry), 'offer another captcha attempt');
    return { action: 'failed', attemptsUsed };
  }

  await deps.captcha.clear(ctx.guildId, challenge.userId);

  const spent = `${WRONG} You are out of attempts.`;
  const failure = planFailure(ctx.config, challenge.userId, deps.now());

  if (failure === null || 'unconfigured' in failure) {
    if (failure !== null) {
      ctx.logger.error(failure.unconfigured, { guildId: ctx.guildId, moduleId: MODULE_ID });
    }

    await run(
      ctx,
      replyEphemeral(to, `${spent} Press Verify to start over with a new one.`),
      'tell the member they are out of attempts',
    );
    return { action: 'failed', attemptsUsed };
  }

  const { plan } = failure;

  // Told before the action lands: a kick or a ban closes the only channel this reply could use.
  await run(ctx, replyEphemeral(to, `${spent} ${plan.told}`), 'tell the member what happens next');

  const result = await run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: plan.kind,
      actorId: VERIFICATION_ACTOR,
      targetId: challenge.userId,
      reason: `Verification: failed the captcha ${attemptsUsed} times.`,
      payload: plan.payload,
      dryRun: false,
      idempotencyKey: `${MODULE_ID}:${eventId}:failure`,
    },
    `act on ${challenge.userId} for failing the captcha`,
  );

  if (!succeeded(result)) {
    ctx.logger.error(
      `verification told ${challenge.userId} they would be ${plan.logged} after ${attemptsUsed} ` +
        `failed captcha attempts, and could not do it: ` +
        `${result.failure?.humanReason ?? 'no reason was reported'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }

  return { action: 'failed', attemptsUsed };
}

interface IssuedCaptcha {
  content: string;
  components: Record<string, unknown>[];
  files: Attachment[];
}

async function issue(
  ctx: ModuleContext<VerificationConfig>,
  deps: BoundCaptchaDeps,
  challenge: CaptchaChallenge,
): Promise<IssuedCaptcha | null> {
  const built = buildCaptchaMessage(
    challenge.challengeId,
    ctx.config.captchaAttempts - challenge.attemptsUsed - 1,
  );

  if (!built.ok) {
    ctx.logger.error(`verification could not build its captcha message: ${built.humanReason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return null;
  }

  try {
    const data = await deps.renderCaptcha({ text: challenge.answer });

    return {
      content: built.content,
      components: built.components,
      files: [{ filename: 'captcha.png', contentType: 'image/png', data: new Uint8Array(data) }],
    };
  } catch (error) {
    ctx.logger.error(
      `the captcha image could not be rendered, so ${challenge.userId} could not be challenged: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return null;
  }
}

async function deliverByDm(
  ctx: ModuleContext<VerificationConfig>,
  to: FollowUpTo,
  userId: string,
  eventId: string,
  message: IssuedCaptcha,
): Promise<boolean> {
  const opened = await run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_dm',
      actorId: VERIFICATION_ACTOR,
      payload: { userId },
      dryRun: false,
      record: false,
      idempotencyKey: `${MODULE_ID}:${eventId}:dm-open`,
    },
    'open a DM for the captcha',
  );

  const channelId = (opened.body as { id?: unknown } | undefined)?.id;
  if (!succeeded(opened) || typeof channelId !== 'string') return false;

  // Discord refuses a closed DM here, on the send, not on the open above — so this is the branch
  // that has to fall back, and it must not be mistaken for a permission problem.
  const sent = await run(
    ctx,
    {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'send',
      actorId: VERIFICATION_ACTOR,
      payload: { channelId, ...message },
      dryRun: false,
      record: false,
      idempotencyKey: `${MODULE_ID}:${eventId}:dm-send`,
    },
    'send the captcha by DM',
  );

  if (!succeeded(sent)) return false;

  await run(
    ctx,
    followUp(to, 'I have sent your captcha by direct message. Open our DMs to answer it.'),
    'point the member at their DMs',
  );

  return true;
}

async function notWired(
  ctx: ModuleContext<VerificationConfig>,
  to: RespondTo,
  unbound: readonly string[],
): Promise<InteractionOutcome> {
  ctx.logger.error(describeUnbound('a verification press was not completed', unbound), {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
  });

  await run(ctx, replyEphemeral(to, NOT_WIRED), 'apologise for an unwired deployment');
  return { action: 'refused', reason: `unbound: ${unbound.join(', ')}` };
}
