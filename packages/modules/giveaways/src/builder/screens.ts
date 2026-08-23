import {
  type AvailableProvider,
  describeMultipliers,
  describeRequirements,
  encodeCustomId,
  type Modal,
  type ProviderRegistry,
} from '@proton/core';
import { ComponentType, TextInputStyle } from 'discord-api-types/v10';
import { describeWait, MODULE_ID, plural, TITLE_MAX } from '../config.ts';
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  BUTTON_SUCCESS,
  type MessageComponent,
} from '../message.ts';
import { LABEL_MAX } from './modal.ts';
import type { GiveawayDraft } from './state.ts';

export const BUILDER_BASICS = 'b:basics';
export const BUILDER_ADD_REQUIREMENT = 'b:addreq';
export const BUILDER_ADD_MULTIPLIER = 'b:addmul';
export const BUILDER_REMOVE = 'b:remove';
export const BUILDER_LOGIC = 'b:logic';
export const BUILDER_PREVIEW = 'b:preview';
export const BUILDER_START = 'b:start';
export const BUILDER_CANCEL = 'b:cancel';

export const BASICS_MODAL = 'b:basics:submit';
export const ITEM_MODAL = 'b:item';

export const TITLE_FIELD = 'title';
export const DESCRIPTION_FIELD = 'description';
export const DURATION_FIELD = 'duration';
export const WINNERS_FIELD = 'winners';

export type ScreenResult =
  | { ok: true; content: string; components: MessageComponent[] }
  | { ok: false; humanReason: string };

function id(action: string, ...args: string[]) {
  return encodeCustomId(MODULE_ID, action, ...args);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function summary(draft: GiveawayDraft, registry: ProviderRegistry): string {
  const lines: string[] = ['## Giveaway builder', ''];

  lines.push(
    draft.title.length === 0
      ? '**Prize** — *not set yet. Press “Basic settings”.*'
      : `**Prize** — ${draft.title}`,
  );

  if (draft.description) lines.push(`**Description** — ${truncate(draft.description, 120)}`);

  lines.push(
    `**Runs for** ${describeWait(draft.durationMs)} · **${plural(draft.winnerCount, 'winner')}**`,
  );

  const requirements = describeRequirements(registry, draft.requirements);
  lines.push(
    '',
    requirements.length === 0
      ? '**Requirements** — anyone can enter'
      : `**Requirements** (${draft.requirementLogic === 'any' ? 'any one of these' : 'all of these'})`,
  );
  for (const [index, line] of requirements.entries()) lines.push(`\`${index + 1}.\` ${line}`);

  const multipliers = describeMultipliers(registry, draft.multipliers);
  lines.push('', multipliers.length === 0 ? '**Bonus entries** — none' : '**Bonus entries**');
  for (const [index, line] of multipliers.entries()) {
    lines.push(`\`${requirements.length + index + 1}.\` ${line}`);
  }

  return lines.join('\n');
}

type RowResult = { ok: true; row: MessageComponent } | { ok: false; humanReason: string };

function pickerRow(
  action: string,
  placeholder: string,
  providers: readonly AvailableProvider[],
  disabledNote: string,
): RowResult {
  const encoded = id(action);
  if (!encoded.ok) return { ok: false, humanReason: encoded.humanReason };

  // A disabled select still has to carry one option: Discord rejects an empty option list, and a
  // host with no modules on should see why rather than an absent control.
  if (providers.length === 0) {
    return {
      ok: true,
      row: {
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
      },
    };
  }

  return {
    ok: true,
    row: {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: encoded.customId,
          placeholder,
          options: providers.slice(0, 25).map((provider) => ({
            label: truncate(provider.label, LABEL_MAX),
            value: provider.id,
            description: truncate(provider.description, 100),
            ...(provider.emoji ? { emoji: { name: provider.emoji } } : {}),
          })),
        },
      ],
    },
  };
}

function removeRow(draft: GiveawayDraft, registry: ProviderRegistry): MessageComponent | null {
  const items = [
    ...draft.requirements.map((item, index) => ({ item, index, kind: 'r' as const })),
    ...draft.multipliers.map((item, index) => ({ item, index, kind: 'm' as const })),
  ];

  if (items.length === 0) return null;

  const encoded = id(BUILDER_REMOVE);
  if (!encoded.ok) return null;

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        custom_id: encoded.customId,
        placeholder: 'Remove something…',
        options: items.slice(0, 25).map(({ item, index, kind }) => {
          const provider = registry.get(item.providerId);
          return {
            label: truncate(provider?.label ?? item.providerId, LABEL_MAX),
            value: `${kind}:${index}`,
            description: kind === 'r' ? 'Requirement' : 'Bonus entries',
          };
        }),
      },
    ],
  };
}

export function builderScreen(
  draft: GiveawayDraft,
  registry: ProviderRegistry,
  available: readonly AvailableProvider[],
): ScreenResult {
  const conditions = available.filter((provider) => provider.kind === 'condition');
  const multipliers = available.filter((provider) => provider.kind === 'multiplier');

  const requirementRow = pickerRow(
    BUILDER_ADD_REQUIREMENT,
    'Add a requirement…',
    conditions,
    'No requirements are available — no module that provides them is on',
  );
  if (!requirementRow.ok) return { ok: false, humanReason: requirementRow.humanReason };

  const multiplierRow = pickerRow(
    BUILDER_ADD_MULTIPLIER,
    'Add bonus entries…',
    multipliers,
    'No bonus-entry rules are available',
  );
  if (!multiplierRow.ok) return { ok: false, humanReason: multiplierRow.humanReason };

  const basics = id(BUILDER_BASICS);
  const logic = id(BUILDER_LOGIC);
  const preview = id(BUILDER_PREVIEW);
  const start = id(BUILDER_START);
  const cancel = id(BUILDER_CANCEL);

  if (!basics.ok) return { ok: false, humanReason: basics.humanReason };
  if (!logic.ok) return { ok: false, humanReason: logic.humanReason };
  if (!preview.ok) return { ok: false, humanReason: preview.humanReason };
  if (!start.ok) return { ok: false, humanReason: start.humanReason };
  if (!cancel.ok) return { ok: false, humanReason: cancel.humanReason };

  const components: MessageComponent[] = [requirementRow.row, multiplierRow.row];

  const remove = removeRow(draft, registry);
  if (remove) components.push(remove);

  const ready = draft.title.trim().length > 0;

  components.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: BUTTON_SECONDARY,
        label: 'Basic settings',
        custom_id: basics.customId,
      },
      {
        type: ComponentType.Button,
        style: BUTTON_SECONDARY,
        label: draft.requirementLogic === 'any' ? 'Needs: any one' : 'Needs: all',
        custom_id: logic.customId,
        disabled: draft.requirements.length < 2,
      },
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
        label: 'Start giveaway',
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
  });

  return {
    ok: true,
    content: ready
      ? summary(draft, registry)
      : `${summary(draft, registry)}\n\n*Set a prize before you can start it.*`,
    components,
  };
}

export type BasicsModalResult = { ok: true; modal: Modal } | { ok: false; humanReason: string };

export function basicsModal(draft: GiveawayDraft): BasicsModalResult {
  const encoded = id(BASICS_MODAL);
  if (!encoded.ok) return { ok: false, humanReason: encoded.humanReason };

  return {
    ok: true,
    modal: {
      customId: encoded.customId,
      title: 'Giveaway basics',
      components: [
        {
          type: ComponentType.Label,
          label: 'Prize',
          component: {
            type: ComponentType.TextInput,
            custom_id: TITLE_FIELD,
            style: TextInputStyle.Short,
            required: true,
            max_length: TITLE_MAX,
            placeholder: 'Nitro for a month',
            ...(draft.title ? { value: draft.title } : {}),
          },
        },
        {
          type: ComponentType.Label,
          label: 'Description',
          description: 'Shown under the prize. Optional.',
          component: {
            type: ComponentType.TextInput,
            custom_id: DESCRIPTION_FIELD,
            style: TextInputStyle.Paragraph,
            required: false,
            max_length: 1500,
            ...(draft.description ? { value: draft.description } : {}),
          },
        },
        {
          type: ComponentType.Label,
          label: 'How long it runs',
          description: 'A number and a unit — 30m, 12h, 7d.',
          component: {
            type: ComponentType.TextInput,
            custom_id: DURATION_FIELD,
            style: TextInputStyle.Short,
            required: true,
            max_length: 16,
            placeholder: '24h',
          },
        },
        {
          type: ComponentType.Label,
          label: 'How many winners',
          component: {
            type: ComponentType.TextInput,
            custom_id: WINNERS_FIELD,
            style: TextInputStyle.Short,
            required: true,
            max_length: 3,
            value: String(draft.winnerCount),
          },
        },
      ],
    },
  };
}
