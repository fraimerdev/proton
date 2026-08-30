import type { AppealLinkClaims, EventBus } from '@proton/core';
import { appealSubmittedSchema } from '@proton/core';
import {
  type AppealAnswers,
  type AppealStore,
  type AppealsConfig,
  type AppealView,
  appealsConfigSchema,
  appealView,
  checkAnswers,
} from '@proton/module-appeals';
import type { ModuleConfigService } from '../modules/service.ts';

export class AppealsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AppealsError';
  }
}

const NO_BUS =
  'Proton cannot reach its event bus, so your appeal was saved but the moderators have not been ' +
  'shown it yet. Open this link again in a few minutes.';

export interface AppealsServiceOptions {
  modules: ModuleConfigService;
  store: AppealStore;
  bus?: EventBus;
  now?(): number;
}

export interface AppealFormView {
  view: AppealView;
  guildId: string;
}

export class AppealsService {
  readonly #options: AppealsServiceOptions;

  constructor(options: AppealsServiceOptions) {
    this.#options = options;
  }

  // A module a server has never switched on is not an error the appellant caused, so it answers a
  // closed view rather than a 500.
  async #config(guildId: string): Promise<AppealsConfig | null> {
    try {
      const held = await this.#options.modules.get(guildId, 'appeals');

      const parsed = appealsConfigSchema.safeParse(held.config);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async #view(claims: AppealLinkClaims): Promise<AppealView> {
    const config = await this.#config(claims.guildId);

    if (!config) {
      return { state: 'closed', humanReason: 'This server is not taking appeals at the moment.' };
    }

    const store = this.#options.store;

    const existing = await store.findByLink(claims.guildId, claims.origin, claims.jti);
    const lastDecidedAt = await store.lastDecidedAt(claims.guildId, claims.userId);

    return appealView({
      config,
      panelId: claims.panelId,
      issuedAt: claims.issuedAt,
      now: this.#options.now?.() ?? Date.now(),
      ...(existing
        ? {
            existing: {
              id: existing.id,
              number: existing.number,
              status: existing.status,
              filedAt: existing.filedAt,
              decidedAt: existing.decidedAt,
            },
          }
        : {}),
      ...(lastDecidedAt === null ? {} : { lastDecidedAt }),
    });
  }

  async form(claims: AppealLinkClaims): Promise<AppealFormView> {
    return { view: await this.#view(claims), guildId: claims.guildId };
  }

  async submit(
    claims: AppealLinkClaims,
    answers: AppealAnswers,
  ): Promise<{ number: number; requestId: string }> {
    // Re-run, never trusted from the client: the page that rendered the form may have been open
    // for a week, and the window may have closed while it sat there.
    const view = await this.#view(claims);

    if (view.state !== 'open') {
      throw new AppealsError(
        'not_open',
        'humanReason' in view ? view.humanReason : 'This appeal can no longer be sent.',
      );
    }

    const checked = checkAnswers(view.panel, answers);
    if (!checked.ok) throw new AppealsError('invalid_answers', checked.humanReason);

    // Written first, published second. If the bus is down the row survives, and re-opening the
    // link republishes because file() is idempotent on (guild, origin, jti).
    const { appeal } = await this.#options.store.file({
      guildId: claims.guildId,
      userId: claims.userId,
      panelId: claims.panelId,
      origin: claims.origin,
      jti: claims.jti,
      answers: checked.answers,
    });

    const bus = this.#options.bus;
    if (!bus) throw new AppealsError('bus_unavailable', NO_BUS);

    const payload = appealSubmittedSchema.parse({
      guildId: claims.guildId,
      userId: claims.userId,
      appealId: appeal.id,
      panelId: claims.panelId,
      origin: claims.origin,
      jti: claims.jti,
      submittedAt: this.#options.now?.() ?? Date.now(),
    });

    // Pinned, not random: the bus does no id dedupe, and a fresh id per publish would give the
    // reviewers a second card every time the link was re-opened.
    const requestId = `appeals.submitted:${claims.guildId}:${claims.jti}`;

    await bus.publish({
      id: requestId,
      type: 'appeals.submitted',
      guildId: claims.guildId,
      occurredAt: this.#options.now?.() ?? Date.now(),
      payload,
    });

    return { number: appeal.number, requestId };
  }
}
