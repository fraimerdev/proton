import type { FieldDescriptor, FieldKind, ShowWhen } from '@proton/core';
import { tryParseDuration } from '@proton/core';
import { createContext, type ReactElement, useContext, useEffect, useMemo } from 'react';
import type { FieldSlot } from '../form/fields.tsx';
import {
  ArrayFieldInput,
  BooleanFieldInput,
  ChannelIdFieldInput,
  ColourFieldInput,
  DurationFieldInput,
  EnumFieldInput,
  NumberFieldInput,
  RoleIdFieldInput,
  SecondsFieldInput,
  StringFieldInput,
} from '../form/fields.tsx';
import type { ModuleForm } from './form.ts';

export { POSTABLE_CHANNEL_TYPES } from '../form/picker.tsx';

const FormContext = createContext<ModuleForm | null>(null);

export function ModuleFormProvider({
  form,
  children,
}: {
  form: ModuleForm;
  children: React.ReactNode;
}): ReactElement {
  return <FormContext.Provider value={form}>{children}</FormContext.Provider>;
}

export function useForm(): ModuleForm {
  const form = useContext(FormContext);
  if (!form) throw new Error('A settings field was rendered outside its ModulePage.');

  return form;
}

interface Common {
  path: string;
  label: string;
  help?: string;
  optional?: boolean;

  // Hidden, not unmounted. A field held off the page by a mode switch still carries a value the
  // save will write, so unmounting it would hide the one thing explaining why Save is refusing.
  hidden?: boolean;
  showWhen?: ShowWhen;

  // Set when the field is one cell of a rule row rather than a row of its own.
  param?: FieldSlot;
}

function base(props: Common, defaultValue?: unknown): Omit<FieldDescriptor, 'kind'> {
  return {
    path: props.path,
    label: props.label,
    optional: props.optional ?? false,
    ...(props.help === undefined ? {} : { description: props.help }),
    ...(defaultValue === undefined ? {} : { defaultValue: defaultValue as never }),
    ...(props.showWhen === undefined ? {} : { showWhen: props.showWhen }),
  };
}

/**
 * Gates Save on the constraint the field already draws its own error from. Without this the page
 * showed the problem and let Save go out anyway, and the API rejected the whole module config —
 * `ModuleConfigService.update` parses all of it — for a value the page had flagged on screen.
 *
 * No unmount cleanup, for the reason usePanelSchema gives below: leaving the area does not take the
 * bad value out of `edits`.
 */
function useFieldGate(path: string, hidden: boolean | undefined, problem: string | null): void {
  const { report } = useForm();

  useEffect(() => {
    if (problem === null) {
      report(path, null);
      return;
    }

    report(path, hidden ? `${problem} It is not on the page you are looking at.` : problem);
  }, [report, path, hidden, problem]);
}

function useBound(descriptor: FieldDescriptor, fallback?: unknown) {
  const form = useForm();

  return {
    descriptor,
    value: form.value(descriptor.path, fallback),
    onChange: (next: unknown) => form.set(descriptor.path, next),
    channels: form.channels,
    roles: form.roles,
  };
}

export function Toggle(props: Common & { defaultValue?: boolean }): ReactElement {
  const descriptor = useMemo<FieldDescriptor>(
    () => ({ ...base(props, props.defaultValue), kind: 'boolean' }),
    [props],
  );

  return (
    <BooleanFieldInput
      {...useBound(descriptor, props.defaultValue ?? false)}
      hidden={props.hidden}
      param={props.param}
    />
  );
}

export function Text(
  props: Common & {
    minLength?: number;
    maxLength?: number;
    defaultValue?: string;

    // For a constraint a length cannot express — the ticket name pattern has to carry {number} or
    // {user}, and without this the whole tickets save was rejected for it at the API.
    validate?: (value: string) => string | null;
  },
): ReactElement {
  const descriptor = useMemo<FieldDescriptor>(
    () => ({
      ...base(props, props.defaultValue),
      kind: 'string',
      ...(props.minLength === undefined ? {} : { minLength: props.minLength }),
      ...(props.maxLength === undefined ? {} : { maxLength: props.maxLength }),
    }),
    [props],
  );

  const bound = useBound(descriptor, props.defaultValue ?? '');
  const held = typeof bound.value === 'string' ? bound.value : '';

  const tooShort =
    props.minLength !== undefined && held.length > 0 && held.length < props.minLength;
  const missing = !props.optional && held === '';

  useFieldGate(
    props.path,
    props.hidden,
    missing
      ? `“${props.label}” needs a value.`
      : tooShort
        ? `“${props.label}” needs at least ${props.minLength} characters.`
        : (props.validate?.(held) ?? null),
  );

  return <StringFieldInput {...bound} hidden={props.hidden} param={props.param} />;
}

export function Num(
  props: Common & { min?: number; max?: number; defaultValue?: number },
): ReactElement {
  const descriptor = useMemo<FieldDescriptor>(
    () => ({
      ...base(props, props.defaultValue),
      kind: 'number',
      ...(props.min === undefined ? {} : { min: props.min }),
      ...(props.max === undefined ? {} : { max: props.max }),
    }),
    [props],
  );

  const bound = useBound(descriptor, props.defaultValue);
  const held = bound.value;

  const outOfRange =
    typeof held === 'number' &&
    ((props.min !== undefined && held < props.min) ||
      (props.max !== undefined && held > props.max));

  useFieldGate(
    props.path,
    props.hidden,
    held === undefined && !props.optional
      ? `“${props.label}” needs a number.`
      : outOfRange
        ? `“${props.label}” must be between ${props.min ?? 0} and ${props.max ?? '∞'}.`
        : null,
  );

  return <NumberFieldInput {...bound} hidden={props.hidden} param={props.param} />;
}

export function Seconds(
  props: Common & { min?: number; max?: number; defaultValue?: number },
): ReactElement {
  const descriptor = useMemo<FieldDescriptor>(
    () => ({
      ...base(props, props.defaultValue),
      kind: 'number',
      ...(props.min === undefined ? {} : { min: props.min }),
      ...(props.max === undefined ? {} : { max: props.max }),
    }),
    [props],
  );

  const bound = useBound(descriptor, props.defaultValue);
  const held = bound.value;

  const outOfRange =
    typeof held === 'number' &&
    ((props.min !== undefined && held < props.min) ||
      (props.max !== undefined && held > props.max));

  useFieldGate(
    props.path,
    props.hidden,
    held === undefined && !props.optional
      ? `“${props.label}” needs a number.`
      : outOfRange
        ? `“${props.label}” must be between ${props.min ?? 0} and ${props.max ?? '∞'}.`
        : null,
  );

  return <SecondsFieldInput {...bound} hidden={props.hidden} param={props.param} />;
}

export function Choice(
  props: Common & {
    options: readonly string[];
    optionLabels?: Record<string, string>;
    defaultValue?: string;
  },
): ReactElement {
  const descriptor = useMemo<FieldDescriptor>(
    () => ({
      ...base(props, props.defaultValue),
      kind: 'enum',
      options: [...props.options],
      ...(props.optionLabels === undefined ? {} : { optionLabels: props.optionLabels }),
    }),
    [props],
  );

  return (
    <EnumFieldInput
      {...useBound(descriptor, props.defaultValue)}
      hidden={props.hidden}
      param={props.param}
    />
  );
}

export function Colour(props: Common & { defaultValue?: string }): ReactElement {
  const descriptor = useMemo<FieldDescriptor>(
    () => ({ ...base(props, props.defaultValue), kind: 'colour' }),
    [props],
  );

  return (
    <ColourFieldInput
      {...useBound(descriptor, props.defaultValue)}
      hidden={props.hidden}
      param={props.param}
    />
  );
}

export function ChannelField(
  props: Common & { channelTypes?: readonly number[]; defaultValue?: string },
): ReactElement {
  const descriptor = useMemo<FieldDescriptor>(
    () => ({
      ...base(props, props.defaultValue),
      kind: 'channel-id',
      ...(props.channelTypes === undefined ? {} : { channelTypes: [...props.channelTypes] }),
    }),
    [props],
  );

  return (
    <ChannelIdFieldInput
      {...useBound(descriptor, props.defaultValue)}
      hidden={props.hidden}
      param={props.param}
    />
  );
}

export function RoleField(props: Common & { defaultValue?: string }): ReactElement {
  const descriptor = useMemo<FieldDescriptor>(
    () => ({ ...base(props, props.defaultValue), kind: 'role-id' }),
    [props],
  );

  return (
    <RoleIdFieldInput
      {...useBound(descriptor, props.defaultValue)}
      hidden={props.hidden}
      param={props.param}
    />
  );
}

export function Duration(props: Common & { defaultValue?: string }): ReactElement {
  const form = useForm();

  const descriptor = useMemo<FieldDescriptor>(
    () => ({ ...base(props, props.defaultValue), kind: 'duration' }),
    [props],
  );

  const bound = useBound(descriptor, props.defaultValue);
  const held = bound.value;
  const unreadable = typeof held === 'string' && held !== '' && tryParseDuration(held) === null;

  const { report } = form;
  const { label, path, hidden } = props;

  // No unmount cleanup, for the reason usePanelSchema gives below: leaving the area this field
  // lives on does not drop the unreadable value from `edits`, so dropping the gate with it let
  // Save go out and be rejected for a duration on a page the reader had left.
  useEffect(() => {
    if (!unreadable) {
      report(path, null);
      return;
    }

    const opening = `“${label}” is not a duration yet`;
    report(path, hidden ? `${opening}, and this page is not showing it right now.` : `${opening}.`);
  }, [report, path, label, hidden, unreadable]);

  return <DurationFieldInput {...bound} hidden={hidden} param={props.param} />;
}

export function Tokens(
  props: Common & {
    kind: Extract<FieldKind, 'string' | 'number' | 'channel-id' | 'role-id' | 'enum'>;
    options?: readonly string[];
    optionLabels?: Record<string, string>;
    maxItems?: number;

    // Forwarded for kind 'channel-id'. ArrayFieldInput has always read it off the descriptor;
    // without a way to pass it, every multi-channel field in the product listed categories.
    channelTypes?: readonly number[];
  },
): ReactElement {
  const descriptor = useMemo<FieldDescriptor>(
    () =>
      ({
        ...base(props, []),
        kind: props.kind,
        array: true,
        ...(props.maxItems === undefined ? {} : { maxItems: props.maxItems }),
        ...(props.kind === 'enum' ? { options: [...(props.options ?? [])] } : {}),
        ...(props.optionLabels === undefined ? {} : { optionLabels: props.optionLabels }),
        ...(props.kind === 'channel-id' && props.channelTypes !== undefined
          ? { channelTypes: [...props.channelTypes] }
          : {}),
      }) as FieldDescriptor,
    [props],
  );

  return (
    <ArrayFieldInput {...useBound(descriptor, [])} hidden={props.hidden} param={props.param} />
  );
}

export const SEVERITY = ['off', 'low', 'medium', 'high'] as const;

/**
 * One check rendered as a row: its severity on the head, its parameters folded underneath. The
 * parameters are hidden and never unmounted — an off check still holds real values that a save can
 * be rejected for, and the command palette still indexes them, so both need a [data-path] to land
 * on.
 */
export function Rule({
  id,
  label,
  path,
  options = SEVERITY,
  defaultValue = 'off',
  offValue = 'off',
  help,
  children,
  stacked,
}: {
  id: string;
  label: string;
  path: string;
  options?: readonly string[];
  defaultValue?: string;
  offValue?: string;
  help?: string;
  children?: React.ReactNode;
  stacked?: React.ReactNode;
}): ReactElement {
  const form = useForm();
  const off = form.value(path, defaultValue) === offValue;
  const body = children !== undefined || stacked !== undefined;

  return (
    <div className="rule" data-rule={id} data-off={off ? 'true' : undefined}>
      <div className="rule-head">
        <span className="rule-label">{label}</span>
        <div className="rule-controls">
          <Choice
            path={path}
            label={label}
            options={options}
            defaultValue={defaultValue}
            param={{ label: undefined }}
            {...(help === undefined ? {} : { help })}
          />
        </div>
      </div>

      {body ? (
        <div className="rule-body" hidden={off}>
          {children === undefined ? null : <div className="rule-params">{children}</div>}
          {stacked}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Save gating for a bespoke editor, against the same schema the editor draws its own errors from.
 * Checked here rather than inside the editor because Save writes the whole config: an editor left
 * half-filled on another area was being written by a Save pressed on this one.
 */
export function usePanelSchema(
  key: string,
  title: string,
  schema: { safeParse: (value: unknown) => { success: boolean } },
  value: unknown,
): void {
  const { report } = useForm();
  const invalid = !schema.safeParse(value).success;

  // Deliberately no unmount cleanup. The gate is up because the config is invalid, not because the
  // editor is on screen, and dropping it when the panel unmounted let a switch to another area of
  // the same module re-enable Save over the half-filled value still sitting in `edits` — which the
  // API then rejected, naming a field on a page the reader was no longer looking at. Reset and a
  // successful save are what clear it.
  useEffect(() => {
    report(key, invalid ? `“${title}” is not filled in yet.` : null);
  }, [report, key, title, invalid]);
}
