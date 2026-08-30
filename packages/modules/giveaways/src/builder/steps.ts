import { type AvailableProvider, encodeCustomId, type ProviderRegistry } from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import { describeWait, MODULE_ID, plural } from '../config.ts';
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  BUTTON_SUCCESS,
  type MessageComponent,
} from '../message.ts';
import { findConflicts } from './conflicts.ts';
import { formatColour, LABEL_MAX } from './modal.ts';
import { BUILDER_STEPS, type GiveawayDraft, STEP_HINTS, STEP_LABELS } from './state.ts';

export const BUILDER_NAV = 'b:nav';
export const BUILDER_EDIT_STEP = 'b:edit';
export const BUILDER_PICK = 'b:pick';
export const BUILDER_ITEM_EDIT = 'b:item:edit';
export const BUILDER_ITEM_REMOVE = 'b:item:rm';
export const BUILDER_MODE = 'b:mode';
export const BUILDER_CATEGORY = 'b:cat';

/**
 * Providers grouped by the module that owns them. §79 asks for categorised menus; the owning
 * module is the categorisation that already exists and stays correct as packs are added, rather
 * than a hand-kept list that drifts.
 */
export const CATEGORY_LABELS: Record<string, string> = {
  core: 'Account & roles',
  leveling: 'Activity & levels',
  cases: 'Moderation record',
  giveaways: 'Giveaway history',
  security: 'Verification',
};

export function categoryLabel(moduleId: string): string {
  return CATEGORY_LABELS[moduleId] ?? moduleId;
}

export function categoriesOf(providers: readonly AvailableProvider[]): string[] {
  return [...new Set(providers.map((provider) => provider.moduleId))].sort();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function id(action: string, ...args: string[]) {
  return encodeCustomId(MODULE_ID, action, ...args);
}

export type StepResult =
  | { ok: true; content: string; components: MessageComponent[] }
  | { ok: false; humanReason: string };

function navRow(draft: GiveawayDraft): MessageComponent | null {
  const encoded = id(BUILDER_NAV);
  if (!encoded.ok) return null;

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        custom_id: encoded.customId,
        placeholder: `Step: ${STEP_LABELS[draft.step]}`,
        options: BUILDER_STEPS.map((step, index) => ({
          label: `${index + 1}. ${STEP_LABELS[step]}`,
          value: step,
          description: truncate(STEP_HINTS[step], 100),
          default: step === draft.step,
        })),
      },
    ],
  };
}

function actionRow(draft: GiveawayDraft, ready: boolean): MessageComponent | null {
  const edit = id(BUILDER_EDIT_STEP, draft.step);
  const preview = id('b:preview');
  const start = id('b:start');
  const cancel = id('b:cancel');

  if (!edit.ok || !preview.ok || !start.ok || !cancel.ok) return null;

  const editable = draft.step !== 'rules' && draft.step !== 'bonus' && draft.step !== 'review';

  return {
    type: ComponentType.ActionRow,
    components: [
      ...(editable
        ? [
            {
              type: ComponentType.Button,
              style: BUTTON_SECONDARY,
              label: `Edit ${STEP_LABELS[draft.step].toLowerCase()}`,
              custom_id: edit.customId,
            },
          ]
        : []),
      {
        type: ComponentType.Button,
        style: BUTTON_PRIMARY,
        label: 'Preview',
        custom_id: preview.customId,
        disabled: !ready,
      },
      {
        type: ComponentType.Button,
        style: BUTTON_SUCCESS,
        label: 'Publish',
        custom_id: start.customId,
        disabled: !ready,
      },
      {
        type: ComponentType.Button,
        style: BUTTON_DANGER,
        label: 'Cancel',
        custom_id: cancel.customId,
      },
    ],
  };
}

function categoryRow(
  draft: GiveawayDraft,
  providers: readonly AvailableProvider[],
  chosen: string | null,
): MessageComponent | null {
  const categories = categoriesOf(providers);
  if (categories.length === 0) return null;

  const encoded = id(BUILDER_CATEGORY, draft.step);
  if (!encoded.ok) return null;

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        custom_id: encoded.customId,
        placeholder: 'Pick a category…',
        options: categories.slice(0, 25).map((moduleId) => ({
          label: truncate(categoryLabel(moduleId), LABEL_MAX),
          value: moduleId,
          description: truncate(
            `${providers.filter((provider) => provider.moduleId === moduleId).length} to choose from`,
            100,
          ),
          default: moduleId === chosen,
        })),
      },
    ],
  };
}

function pickerRow(
  kind: 'r' | 'm',
  providers: readonly AvailableProvider[],
  disabledNote: string,
): MessageComponent | null {
  const encoded = id(BUILDER_PICK, kind);
  if (!encoded.ok) return null;

  // A disabled select still carries one filler option: Discord refuses an empty option list, and a
  // host with no modules on should see why rather than an absent control.
  if (providers.length === 0) {
    return {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: encoded.customId,
          placeholder: truncate(disabledNote, 150),
          disabled: true,
          options: [{ label: 'none', value: 'none' }],
        },
      ],
    };
  }

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        custom_id: encoded.customId,
        placeholder: kind === 'r' ? 'Add a requirement…' : 'Add bonus entries…',
        options: providers.slice(0, 25).map((provider) => ({
          label: truncate(provider.label, LABEL_MAX),
          value: provider.id,
          description: truncate(provider.description, 100),
          ...(provider.emoji ? { emoji: { name: provider.emoji } } : {}),
        })),
      },
    ],
  };
}

function itemRow(
  kind: 'r' | 'm',
  action: string,
  placeholder: string,
  items: readonly { providerId: string }[],
  registry: ProviderRegistry,
): MessageComponent | null {
  if (items.length === 0) return null;

  const encoded = id(action, kind);
  if (!encoded.ok) return null;

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        custom_id: encoded.customId,
        placeholder,
        options: items.slice(0, 25).map((item, index) => ({
          label: truncate(registry.get(item.providerId)?.label ?? item.providerId, LABEL_MAX),
          value: String(index),
          description: `Rule ${index + 1}`,
        })),
      },
    ],
  };
}

function logicRow(draft: GiveawayDraft): MessageComponent | null {
  const encoded = id('b:logic');
  if (!encoded.ok) return null;

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: BUTTON_SECONDARY,
        label: draft.requirementLogic === 'any' ? 'Needs: any one of these' : 'Needs: all of these',
        custom_id: encoded.customId,
        disabled: draft.requirements.length < 2,
      },
    ],
  };
}

function modeRow(draft: GiveawayDraft): MessageComponent | null {
  if (draft.multipliers.length === 0) return null;

  const encoded = id(BUILDER_MODE);
  if (!encoded.ok) return null;

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        custom_id: encoded.customId,
        placeholder: 'Change how a bonus stacks…',
        options: draft.multipliers.slice(0, 8).flatMap((item, index) =>
          (['add', 'multiply', 'max'] as const).map((mode) => ({
            label: truncate(`Rule ${index + 1}: ${MODE_LABELS[mode]}`, LABEL_MAX),
            value: `${index}:${mode}`,
            default: item.mode === mode,
          })),
        ),
      },
    ],
  };
}

const MODE_LABELS = {
  add: 'add entries',
  multiply: 'multiply entries',
  max: 'highest only',
} as const;

function heading(draft: GiveawayDraft): string {
  const index = BUILDER_STEPS.indexOf(draft.step) + 1;
  return `## ${STEP_LABELS[draft.step]}\n-# Step ${index} of ${BUILDER_STEPS.length} · ${STEP_HINTS[draft.step]}`;
}

function unset(value: string | null, fallback: string): string {
  return value === null || value.length === 0 ? `*${fallback}*` : value;
}

function basicsBody(draft: GiveawayDraft): string {
  return [
    heading(draft),
    '',
    `**Prize** — ${unset(draft.title, 'not set yet')}`,
    `**Description** — ${unset(draft.description, 'none')}`,
    `**Runs for** — ${describeWait(draft.durationMs)}`,
    draft.startsInMs === null
      ? '**Starts** — as soon as you publish'
      : `**Starts** — in ${describeWait(draft.startsInMs)}`,
  ].join('\n');
}

function rulesBody(draft: GiveawayDraft, registry: ProviderRegistry): string {
  const lines = [heading(draft), ''];

  if (draft.requirements.length === 0) {
    lines.push('*Anybody in the server can enter. Add a requirement to narrow that.*');
  } else {
    lines.push(
      draft.requirementLogic === 'any'
        ? '**Entrants need any one of these:**'
        : '**Entrants need all of these:**',
    );

    for (const [index, item] of draft.requirements.entries()) {
      const provider = registry.condition(item.providerId);
      lines.push(
        `\`${index + 1}.\` ${provider ? provider.describe(item.config, 'en-GB') : item.providerId}`,
      );
    }
  }

  return lines.join('\n');
}

function bonusBody(draft: GiveawayDraft, registry: ProviderRegistry): string {
  const lines = [heading(draft), ''];

  if (draft.multipliers.length === 0) {
    lines.push('*Everybody who qualifies gets one entry.*');
  } else {
    for (const [index, item] of draft.multipliers.entries()) {
      const provider = registry.multiplier(item.providerId);
      lines.push(
        `\`${index + 1}.\` ${provider ? provider.describe(item.config, 'en-GB') : item.providerId}` +
          ` — *${MODE_LABELS[item.mode]}*`,
      );
    }
  }

  return lines.join('\n');
}

function lookBody(draft: GiveawayDraft): string {
  return [
    heading(draft),
    '',
    `**Colour** — ${draft.color === null ? '*the server default*' : (formatColour(draft.color) ?? '')}`,
    `**Emoji** — ${unset(draft.emoji, 'the default 🎉')}`,
    `**Image** — ${unset(draft.bannerUrl, 'none')}`,
  ].join('\n');
}

function winnersBody(draft: GiveawayDraft): string {
  return [
    heading(draft),
    '',
    `**Winners** — ${plural(draft.winnerCount, 'winner')}`,
    `**Entry cap** — ${draft.maxEntriesPerUser === null ? '*no cap*' : `${draft.maxEntriesPerUser} each`}`,
    `**DM the winners** — ${draft.dmWinners ? 'yes' : 'no'}`,
    `**Claim window** — ${
      draft.claimWindowSeconds === null
        ? '*none, winners keep their prize*'
        : describeWait(draft.claimWindowSeconds * 1000)
    }`,
    `**Reward role** — ${draft.rewardRoleId === null ? '*none*' : `<@&${draft.rewardRoleId}>`}`,
  ].join('\n');
}

function reviewBody(draft: GiveawayDraft, registry: ProviderRegistry): string {
  const conflicts = findConflicts(
    registry,
    draft.requirements,
    draft.multipliers,
    draft.requirementLogic,
  );

  const lines = [
    heading(draft),
    '',
    `**${unset(draft.title, 'no prize set')}**`,
    draft.description ?? '',
    '',
    `${plural(draft.winnerCount, 'winner')} · runs for ${describeWait(draft.durationMs)}` +
      `${draft.startsInMs === null ? '' : ` · starts in ${describeWait(draft.startsInMs)}`}`,
    '',
    rulesBody({ ...draft, step: 'rules' }, registry)
      .split('\n')
      .slice(2)
      .join('\n'),
    '',
    bonusBody({ ...draft, step: 'bonus' }, registry)
      .split('\n')
      .slice(2)
      .join('\n'),
  ];

  if (conflicts.length > 0) {
    lines.push('', '**Before you publish**');
    for (const conflict of conflicts) {
      lines.push(`${conflict.blocking ? '🛑' : '⚠️'} ${conflict.humanReason}`);
    }
  }

  return lines.filter((line, index) => line.length > 0 || index > 0).join('\n');
}

export function readyToPublish(draft: GiveawayDraft, registry: ProviderRegistry): boolean {
  if (draft.title.trim().length === 0) return false;

  return findConflicts(
    registry,
    draft.requirements,
    draft.multipliers,
    draft.requirementLogic,
  ).every((conflict) => !conflict.blocking);
}

export function stepScreen(
  draft: GiveawayDraft,
  registry: ProviderRegistry,
  available: readonly AvailableProvider[],
  category: string | null = null,
): StepResult {
  const nav = navRow(draft);
  if (!nav) return { ok: false, humanReason: 'the builder navigation could not be built' };

  const ready = readyToPublish(draft, registry);
  const action = actionRow(draft, ready);
  if (!action) return { ok: false, humanReason: 'the builder controls could not be built' };

  const middle: MessageComponent[] = [];
  let content: string;

  switch (draft.step) {
    case 'rules': {
      const conditions = available.filter((provider) => provider.kind === 'condition');
      const shown =
        category === null
          ? conditions
          : conditions.filter((provider) => provider.moduleId === category);

      const categories = categoryRow(draft, conditions, category);
      if (categories) middle.push(categories);

      const picker = pickerRow(
        'r',
        shown,
        'No requirements available — switch on a module that provides them',
      );
      if (picker) middle.push(picker);

      const edit = itemRow(
        'r',
        BUILDER_ITEM_EDIT,
        'Change or remove a requirement…',
        draft.requirements,
        registry,
      );
      if (edit) middle.push(edit);
      else {
        const logic = logicRow(draft);
        if (logic) middle.push(logic);
      }

      content = rulesBody(draft, registry);
      break;
    }

    case 'bonus': {
      const multipliers = available.filter((provider) => provider.kind === 'multiplier');
      const shown =
        category === null
          ? multipliers
          : multipliers.filter((provider) => provider.moduleId === category);

      const categories = categoryRow(draft, multipliers, category);
      if (categories) middle.push(categories);

      const picker = pickerRow(
        'm',
        shown,
        'No bonus entries available — switch on a module that provides them',
      );
      if (picker) middle.push(picker);

      const mode = modeRow(draft);
      if (mode) middle.push(mode);

      content = bonusBody(draft, registry);
      break;
    }

    case 'look':
      content = lookBody(draft);
      break;

    case 'winners':
      content = winnersBody(draft);
      break;

    case 'review':
      content = reviewBody(draft, registry);
      break;

    default:
      content = basicsBody(draft);
  }

  // Five action rows is the message ceiling, and nav plus actions already take two.
  const components = [nav, ...middle.slice(0, 3), action];

  return { ok: true, content, components };
}

export function itemLogicRow(draft: GiveawayDraft): MessageComponent | null {
  return logicRow(draft);
}

export { MODE_LABELS };
