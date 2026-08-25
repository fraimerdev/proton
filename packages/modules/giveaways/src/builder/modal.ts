import type { FieldDescriptor, Modal } from '@proton/core';
import { MAX_COMPONENTS_PER_MODAL, tryParseDuration } from '@proton/core';
import { ComponentType, TextInputStyle } from 'discord-api-types/v10';

export const LABEL_MAX = 45;
export const DESCRIPTION_MAX = 100;
export const TEXT_INPUT_MAX = 4000;

export type ModalComponent = Record<string, unknown>;

export type BuildModalResult = { ok: true; modal: Modal } | { ok: false; humanReason: string };

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function currentValue(current: Record<string, unknown> | undefined, path: string): unknown {
  return current?.[path];
}

function selectFor(
  descriptor: FieldDescriptor,
  current: unknown,
): ModalComponent | { unsupported: string } {
  const many = descriptor.array === true;
  const chosen = Array.isArray(current) ? current.map(String) : [];

  const common = {
    custom_id: descriptor.path,
    required: !descriptor.optional,
    min_values: descriptor.optional ? 0 : 1,
    max_values: many ? Math.min(descriptor.maxItems ?? 25, 25) : 1,
  };

  switch (descriptor.kind) {
    case 'role-id':
      return {
        type: ComponentType.RoleSelect,
        ...common,
        ...(chosen.length > 0
          ? { default_values: chosen.map((id) => ({ id, type: 'role' })) }
          : {}),
      };

    case 'channel-id':
      return {
        type: ComponentType.ChannelSelect,
        ...common,
        ...(descriptor.channelTypes ? { channel_types: descriptor.channelTypes } : {}),
        ...(chosen.length > 0
          ? { default_values: chosen.map((id) => ({ id, type: 'channel' })) }
          : {}),
      };

    case 'enum':
      return {
        type: ComponentType.StringSelect,
        ...common,
        max_values: 1,
        options: descriptor.options.slice(0, 25).map((option) => ({
          label: clamp(option, LABEL_MAX),
          value: option,
          default: asString(current) === option,
        })),
      };

    case 'boolean':
      return {
        type: ComponentType.StringSelect,
        ...common,
        max_values: 1,
        options: [
          { label: 'Yes', value: 'true', default: current === true },
          { label: 'No', value: 'false', default: current === false },
        ],
      };

    default:
      return { unsupported: descriptor.kind };
  }
}

// There is no numeric modal component — Text Input has two styles and neither is a number — so a
// number is a Short input parsed on submit. Discord cannot enforce the range for us.
function textFor(descriptor: FieldDescriptor, current: unknown): ModalComponent {
  // Colour renders as hex both ways: a stored 5793266 shown as 5793266 is not a value anybody can
  // recognise or retype.
  const value = descriptor.kind === 'colour' ? formatColour(current) : asString(current);

  const placeholder =
    descriptor.kind === 'duration'
      ? 'For example 30m, 12h or 7d'
      : descriptor.kind === 'colour'
        ? 'A hex colour like #5865F2'
        : descriptor.kind === 'number'
          ? numberHint(descriptor)
          : undefined;

  return {
    type: ComponentType.TextInput,
    custom_id: descriptor.path,
    style: TextInputStyle.Short,
    required: !descriptor.optional,
    max_length: descriptor.kind === 'string' ? (descriptor.maxLength ?? 200) : 64,
    ...(placeholder ? { placeholder: clamp(placeholder, DESCRIPTION_MAX) } : {}),
    ...(value !== undefined ? { value: clamp(value, TEXT_INPUT_MAX) } : {}),
  };
}

export const COLOUR_MAX = 0xffffff;

/**
 * Colour is stored as a number and typed by hand as hex — `#5865F2` is what a host copies out of
 * Discord, and `5793266` is not. Accepts either, and the decimal form so a value read back out of
 * config round-trips.
 */
export function parseColour(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // A leading # forces hex. Without this "#12345" falls through to the decimal branch and becomes
  // 12345 — a colour nobody asked for, from an input that was plainly a mistyped hex code.
  const hashed = trimmed.startsWith('#');
  const body = hashed ? trimmed.slice(1) : trimmed;

  const value = /^[0-9a-fA-F]{6}$/.test(body)
    ? Number.parseInt(body, 16)
    : !hashed && /^\d+$/.test(body)
      ? Number.parseInt(body, 10)
      : Number.NaN;

  if (!Number.isInteger(value) || value < 0 || value > COLOUR_MAX) return null;

  return value;
}

export function formatColour(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
}

function numberHint(descriptor: Extract<FieldDescriptor, { kind: 'number' }>): string {
  if (descriptor.min !== undefined && descriptor.max !== undefined) {
    return `A whole number between ${descriptor.min} and ${descriptor.max}`;
  }
  if (descriptor.min !== undefined) return `A whole number, at least ${descriptor.min}`;
  return 'A whole number';
}

function labelled(descriptor: FieldDescriptor, current: unknown): ModalComponent | null {
  const built =
    descriptor.kind === 'role-id' ||
    descriptor.kind === 'channel-id' ||
    descriptor.kind === 'enum' ||
    descriptor.kind === 'boolean'
      ? selectFor(descriptor, current)
      : textFor(descriptor, current);

  if ('unsupported' in built) return null;

  return {
    type: ComponentType.Label,
    label: clamp(descriptor.label, LABEL_MAX),
    ...(descriptor.description
      ? { description: clamp(descriptor.description, DESCRIPTION_MAX) }
      : {}),
    component: built,
  };
}

export function descriptorsToModal(
  customId: string,
  title: string,
  descriptors: readonly FieldDescriptor[],
  current?: Record<string, unknown>,
): BuildModalResult {
  if (descriptors.length > MAX_COMPONENTS_PER_MODAL) {
    return {
      ok: false,
      humanReason:
        `That setting has ${descriptors.length} fields and a Discord modal holds at most ` +
        `${MAX_COMPONENTS_PER_MODAL}. Configure it from the dashboard instead.`,
    };
  }

  const components: ModalComponent[] = [];
  for (const descriptor of descriptors) {
    const component = labelled(descriptor, currentValue(current, descriptor.path));
    if (component) components.push(component);
  }

  // A modal has to hold at least one component. A provider with no settings is configured by
  // picking it, so the caller shows a confirmation instead of an empty modal.
  if (components.length === 0) {
    return { ok: false, humanReason: 'That setting has nothing to fill in.' };
  }

  return { ok: true, modal: { customId, title: clamp(title, LABEL_MAX), components } };
}

export type ReadValuesResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; humanReason: string };

function readNumber(
  descriptor: Extract<FieldDescriptor, { kind: 'number' }>,
  raw: string,
): { ok: true; value: number } | { ok: false; humanReason: string } {
  const trimmed = raw.trim();
  const value = Number(trimmed);

  if (trimmed.length === 0 || !Number.isFinite(value)) {
    return {
      ok: false,
      humanReason: `“${raw}” is not a number. ${descriptor.label} needs a plain number like 5.`,
    };
  }

  if (descriptor.min !== undefined && value < descriptor.min) {
    return {
      ok: false,
      humanReason: `${descriptor.label} has to be at least ${descriptor.min}, and you gave ${value}.`,
    };
  }

  if (descriptor.max !== undefined && value > descriptor.max) {
    return {
      ok: false,
      humanReason: `${descriptor.label} can be at most ${descriptor.max}, and you gave ${value}.`,
    };
  }

  return { ok: true, value };
}

export function readDescriptorValues(
  descriptors: readonly FieldDescriptor[],
  fields: Record<string, string>,
  values: Record<string, string[]>,
): ReadValuesResult {
  const config: Record<string, unknown> = {};

  for (const descriptor of descriptors) {
    const path = descriptor.path;
    const selected = values[path];
    const text = fields[path];

    switch (descriptor.kind) {
      case 'role-id':
      case 'channel-id': {
        const chosen = selected ?? [];
        if (chosen.length === 0) {
          if (!descriptor.optional) {
            return { ok: false, humanReason: `${descriptor.label} needs at least one choice.` };
          }
          break;
        }

        config[path] = descriptor.array === true ? chosen : chosen[0];
        break;
      }

      case 'enum': {
        const chosen = selected?.[0];
        if (chosen === undefined) {
          if (!descriptor.optional) {
            return { ok: false, humanReason: `${descriptor.label} needs a choice.` };
          }
          break;
        }
        config[path] = chosen;
        break;
      }

      case 'boolean': {
        const chosen = selected?.[0];
        if (chosen === undefined) break;
        config[path] = chosen === 'true';
        break;
      }

      case 'number': {
        if (text === undefined || text.trim().length === 0) {
          if (!descriptor.optional) {
            return { ok: false, humanReason: `${descriptor.label} needs a number.` };
          }
          break;
        }

        const parsed = readNumber(descriptor, text);
        if (!parsed.ok) return parsed;

        config[path] = parsed.value;
        break;
      }

      case 'colour': {
        if (text === undefined || text.trim().length === 0) {
          if (!descriptor.optional) {
            return { ok: false, humanReason: `${descriptor.label} needs a colour.` };
          }
          break;
        }

        // Parsed to a number here: the field is a z.number(), and storing the typed string sails
        // past the modal and fails at parseConfig with a message about the wrong type.
        const colour = parseColour(text);
        if (colour === null) {
          return {
            ok: false,
            humanReason:
              `“${text}” is not a colour I can read. Give a hex code like #5865F2, or a plain ` +
              'number between 0 and 16777215.',
          };
        }

        config[path] = colour;
        break;
      }

      case 'duration': {
        if (text === undefined || text.trim().length === 0) {
          if (!descriptor.optional) {
            return { ok: false, humanReason: `${descriptor.label} needs a length of time.` };
          }
          break;
        }

        if (tryParseDuration(text.trim()) === null) {
          return {
            ok: false,
            humanReason:
              `“${text}” is not a length of time I understand. Give a number followed by ` +
              's, m, h, d or w — for example 30m, 12h or 7d.',
          };
        }

        config[path] = text.trim();
        break;
      }

      default: {
        if (text === undefined || text.trim().length === 0) {
          if (!descriptor.optional) {
            return { ok: false, humanReason: `${descriptor.label} cannot be left empty.` };
          }
          break;
        }
        config[path] = text.trim();
      }
    }
  }

  return { ok: true, config };
}
