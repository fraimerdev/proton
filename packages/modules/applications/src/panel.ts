import {
  type ActionExecutor,
  checkListLimit,
  type EntitlementTier,
  MESSAGE_FLAG_IS_COMPONENTS_V2,
} from '@proton/core';
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import { type ApplicationsConfig, type FormConfig, formFor, type PanelConfig } from './config.ts';
import { MODULE_ID, PANEL_BUTTON_FORMS_MAX, PANEL_FORMS_MAX } from './constants.ts';
import { APPLICANT_ACTION, customId } from './interface.ts';
import { clip } from './modal.ts';
import {
  ACCENT,
  button,
  buttonRows,
  type Component,
  emojiOf,
  mineButton,
  row,
  separator,
  text,
} from './overview.ts';

const OPTION_TEXT_MAX = 100;
const BUTTON_LABEL_MAX = 80;
const PLACEHOLDER = 'Choose a form to see what it asks';

export type BuildPanelResult =
  | { ok: true; components: Record<string, unknown>[] }
  | { ok: false; humanReason: string };

function formsOf(config: ApplicationsConfig, panel: PanelConfig): FormConfig[] {
  return panel.formIds
    .map((formId) => formFor(config, formId))
    .filter((form): form is FormConfig => form !== undefined);
}

function formButton(panel: PanelConfig, form: FormConfig): Component {
  return button({
    label: clip(form.name, BUTTON_LABEL_MAX),
    customId: customId(APPLICANT_ACTION.open, panel.id, form.id),
    style: ButtonStyle.Primary,
    emoji: form.emoji,
  });
}

function formOption(form: FormConfig): Component {
  const emoji = emojiOf(form.emoji);
  return {
    label: clip(form.name, OPTION_TEXT_MAX),
    value: form.id,
    ...(form.description === '' ? {} : { description: clip(form.description, OPTION_TEXT_MAX) }),
    ...(emoji ? { emoji } : {}),
  };
}

export function buildPanel(config: ApplicationsConfig, panel: PanelConfig): BuildPanelResult {
  const forms = formsOf(config, panel);

  if (forms.length === 0) {
    return {
      ok: false,
      humanReason:
        `The **${panel.name}** panel lists no forms that exist, so members could apply to ` +
        'nothing. Add a form to it in the Proton dashboard under Applications → Panels.',
    };
  }

  const select = panel.style === 'select';
  const limit = select ? PANEL_FORMS_MAX : PANEL_BUTTON_FORMS_MAX;
  if (forms.length > limit) {
    return {
      ok: false,
      humanReason: select
        ? `The **${panel.name}** panel lists ${forms.length} forms and a dropdown holds ${PANEL_FORMS_MAX}. Remove some in the Proton dashboard under Applications → Panels.`
        : `The **${panel.name}** panel lists ${forms.length} forms and a panel with buttons holds ${PANEL_BUTTON_FORMS_MAX}. Switch it to a dropdown in the Proton dashboard under Applications → Panels.`,
    };
  }

  const parts: Component[] = [];
  const heading = panel.title === '' ? '' : `## ${panel.title}`;
  const intro = [heading, panel.body].filter((part) => part !== '').join('\n');
  if (intro !== '') parts.push(text(intro));
  parts.push(separator());

  if (select) {
    parts.push(
      row({
        type: ComponentType.StringSelect,
        custom_id: customId(APPLICANT_ACTION.openSelect, panel.id),
        placeholder: PLACEHOLDER,
        min_values: 1,
        max_values: 1,
        options: forms.map(formOption),
      }),
    );
    if (panel.showMine) parts.push(row(mineButton()));
  } else {
    parts.push(...buttonRows(forms.map((form) => formButton(panel, form))));
    if (panel.showMine) parts.push(row(mineButton()));
  }

  return {
    ok: true,
    components: [
      {
        type: ComponentType.Container,
        accent_color: panel.colour ?? ACCENT,
        components: parts,
      },
    ],
  };
}

export type SendPanelResult =
  | { ok: true; messageId: string | null }
  | { ok: false; humanReason: string };

export async function sendPanel(
  ctx: {
    guildId: string;
    executor: ActionExecutor;
    config: ApplicationsConfig;
    tier?: EntitlementTier;
  },
  panel: PanelConfig,
  options: { actorId: string; idempotencyKey: string },
): Promise<SendPanelResult> {
  const allowed = checkListLimit(ctx.tier ?? 'free', 'applicationPanels', ctx.config.panels.length);
  if (!allowed.ok) return { ok: false, humanReason: allowed.humanReason };

  if (panel.channelId === undefined) {
    return {
      ok: false,
      humanReason:
        `The **${panel.name}** panel has no channel to post in. Choose one in the Proton ` +
        'dashboard under Applications → Panels.',
    };
  }

  const built = buildPanel(ctx.config, panel);
  if (!built.ok) return built;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: options.actorId,
    idempotencyKey: `${options.idempotencyKey}:panel`,
    dryRun: false,
    record: false,
    payload: {
      channelId: panel.channelId,
      components: built.components,
      flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    return {
      ok: false,
      humanReason:
        result.failure?.humanReason ?? 'Discord refused the panel for an unknown reason.',
    };
  }

  const body = result.body as { id?: unknown } | undefined;
  return { ok: true, messageId: typeof body?.id === 'string' ? body.id : null };
}
