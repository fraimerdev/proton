import type {
  ActionRow,
  ContainerChild,
  MediaItem,
  MessageButton,
  SectionAccessory,
  V2Component,
} from '@proton/core';
import {
  BUTTON_LABEL_MAX,
  BUTTON_URL_MAX,
  BUTTONS_PER_ROW_MAX,
  countV2Components,
  MEDIA_GALLERY_ITEMS_MAX,
  SECTION_TEXT_MAX,
  V2_COMPONENTS_MAX,
} from '@proton/core';
import { HONEYPOT_COLOUR } from '@proton/module-honeypot/config';
import type { ReactElement, ReactNode } from 'react';
import { useRef, useState } from 'react';
import { EmojiPicker } from '../../components/discord/emoji-picker.tsx';
import { ColourPicker } from '../../components/discord/inputs.tsx';
import { PresenceList, useRecent } from '../../components/ui/collection.tsx';
import {
  Button,
  cx,
  IconButton,
  SegmentedControl,
  type SegmentedOption,
  Switch,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import type { IconName } from '../../components/ui/icon.tsx';
import { ExpandableRow, Rows } from '../../components/ui/layout.tsx';
import { Popover } from '../../components/ui/overlay.tsx';
import type { ConfigErrors } from './shape.ts';

type ChildKind = ContainerChild['kind'];
type Kind = V2Component['kind'];
type ButtonRow = Extract<ActionRow, { kind: 'buttons' }>;

const KIND_LABEL: Record<Kind, string> = {
  text: 'Text',
  separator: 'Divider',
  gallery: 'Images',
  section: 'Text with an accessory',
  row: 'Link buttons',
  container: 'Container',
};

const KIND_ICON: Record<Kind, IconName> = {
  text: 'chat-centered-text',
  separator: 'minus',
  gallery: 'image',
  section: 'list',
  row: 'squares-four',
  container: 'archive',
};

const SPACING: readonly SegmentedOption<'small' | 'large'>[] = [
  { value: 'small', label: 'Small' },
  { value: 'large', label: 'Large' },
];

const ACCESSORY: readonly SegmentedOption<'thumbnail' | 'button'>[] = [
  { value: 'thumbnail', label: 'Image' },
  { value: 'button', label: 'Link button' },
];

const TOP_KINDS: readonly Kind[] = ['container', 'text', 'separator', 'gallery', 'section', 'row'];
const CHILD_KINDS: readonly ChildKind[] = ['text', 'separator', 'gallery', 'section', 'row'];

export function takenKeys(components: readonly V2Component[]): Set<string> {
  const keys = new Set<string>();

  const fromChild = (child: ContainerChild): void => {
    if (child.kind === 'row' && child.row.kind === 'buttons') {
      for (const button of child.row.buttons) keys.add(button.key);
    }
    if (child.kind === 'row' && child.row.kind === 'select') keys.add(child.row.select.key);
    if (child.kind === 'section' && child.accessory.kind === 'button') {
      keys.add(child.accessory.button.key);
    }
  };

  for (const component of components) {
    if (component.kind === 'container') for (const child of component.children) fromChild(child);
    else fromChild(component);
  }

  return keys;
}

function newLinkButton(taken: ReadonlySet<string>): MessageButton {
  let index = 1;
  while (taken.has(`link${index}`)) index += 1;

  return { key: `link${index}`, style: 'link', label: 'Open', url: '' };
}

function seedChild(kind: ChildKind, taken: ReadonlySet<string>): ContainerChild {
  switch (kind) {
    case 'text':
      return { kind: 'text', content: '' };
    case 'separator':
      return { kind: 'separator', divider: true, spacing: 'small' };
    case 'gallery':
      return { kind: 'gallery', items: [{ url: '' }] };
    case 'section':
      return { kind: 'section', text: [''], accessory: { kind: 'thumbnail', url: '' } };
    case 'row':
      return { kind: 'row', row: { kind: 'buttons', buttons: [newLinkButton(taken)] } };
  }
}

function summarise(component: V2Component): string | undefined {
  switch (component.kind) {
    case 'text':
      return component.content.split('\n')[0] || undefined;
    case 'gallery':
      return `${component.items.length} image${component.items.length === 1 ? '' : 's'}`;
    case 'section':
      return component.text[0] || undefined;
    case 'row':
      return component.row.kind === 'buttons'
        ? `${component.row.buttons.length} button${component.row.buttons.length === 1 ? '' : 's'}`
        : 'A dropdown';
    case 'container':
      return `${component.children.length} inside`;
    case 'separator':
      return component.divider ? 'A line' : 'Blank space';
  }
}

function move<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const held = next[from];
  if (held === undefined || to < 0 || to >= next.length) return next;

  next.splice(from, 1);
  next.splice(to, 0, held);
  return next;
}

function AddMenu<K extends Kind>({
  kinds,
  onAdd,
  label,
}: {
  kinds: readonly K[];
  onAdd: (kind: K) => void;
  label: string;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        ref={anchor}
        size="sm"
        icon="plus"
        trailingIcon="caret-down"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} minWidth={220}>
        <div role="menu">
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                onAdd(kind);
                setOpen(false);
              }}
            >
              {KIND_LABEL[kind]}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function LinkButtons({
  guildId,
  row,
  taken,
  onChange,
  errors,
  prefix,
}: {
  guildId: string;
  row: ButtonRow;
  taken: ReadonlySet<string>;
  onChange: (next: ButtonRow) => void;
  errors: ConfigErrors;
  prefix: string;
}): ReactElement {
  const recent = useRecent();

  const set = (index: number, next: MessageButton): void =>
    onChange({
      kind: 'buttons',
      buttons: row.buttons.map((button, at) => (at === index ? next : button)),
    });

  return (
    <div className="panel-sunken stack stack-12 honeypot-detail-wide">
      <PresenceList>
        {row.buttons.map((button, index) => {
          const labelError = errors.at(`${prefix}.${index}.label`);
          const urlError = errors.at(`${prefix}.${index}.url`);

          return (
            <div className={cx('stack stack-8', recent.enter(button.key, 'part'))} key={button.key}>
              <div className="inline inline-8 inline-wrap">
                <EmojiPicker
                  guildId={guildId}
                  label={`Button ${index + 1} emoji`}
                  value={button.emoji ?? null}
                  onChange={(emoji) => set(index, { ...button, emoji: emoji ?? undefined })}
                />
                <TextInput
                  aria-label={`Button ${index + 1} label`}
                  className="control-w-md"
                  placeholder="Label"
                  maxLength={BUTTON_LABEL_MAX}
                  invalid={labelError !== undefined}
                  value={button.label ?? ''}
                  onChange={(event) =>
                    set(index, { ...button, label: event.currentTarget.value || undefined })
                  }
                />
                <span className="push-right">
                  <IconButton
                    icon="trash"
                    tone="ghost"
                    size="sm"
                    label={`Remove button ${index + 1}`}
                    onClick={() =>
                      onChange({
                        kind: 'buttons',
                        buttons: row.buttons.filter((_, at) => at !== index),
                      })
                    }
                  />
                </span>
              </div>

              <TextInput
                aria-label={`Button ${index + 1} link`}
                placeholder="https://…"
                maxLength={BUTTON_URL_MAX}
                invalid={urlError !== undefined}
                value={button.url ?? ''}
                onChange={(event) =>
                  set(index, { ...button, url: event.currentTarget.value || undefined })
                }
              />

              {labelError !== undefined ? <p className="row-error">{labelError}</p> : null}
              {urlError !== undefined ? <p className="row-error">{urlError}</p> : null}
            </div>
          );
        })}
      </PresenceList>

      <div className="inline inline-8">
        <Button
          size="sm"
          icon="plus"
          disabled={row.buttons.length >= BUTTONS_PER_ROW_MAX}
          onClick={() => {
            const button = newLinkButton(taken);
            recent.mark(button.key);
            onChange({ kind: 'buttons', buttons: [...row.buttons, button] });
          }}
        >
          Add button
        </Button>
        <span className="text-xs text-muted">
          {row.buttons.length} / {BUTTONS_PER_ROW_MAX}
        </span>
      </div>
    </div>
  );
}

function GalleryFields({
  items,
  onChange,
  errors,
  prefix,
}: {
  items: readonly MediaItem[];
  onChange: (next: MediaItem[]) => void;
  errors: ConfigErrors;
  prefix: string;
}): ReactElement {
  const recent = useRecent();

  return (
    <div className="stack stack-8 honeypot-detail-wide">
      {items.map((item, index) => {
        const urlError = errors.at(`${prefix}.items.${index}.url`);

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: an image's position in the gallery is its identity
          <div className={cx('stack stack-6', recent.enter(index))} key={index}>
            <div className="inline inline-8">
              <TextInput
                aria-label={`Image ${index + 1} address`}
                placeholder="https://…"
                invalid={urlError !== undefined}
                value={item.url}
                onChange={(event) =>
                  onChange(
                    items.map((current, at) =>
                      at === index ? { ...current, url: event.currentTarget.value } : current,
                    ),
                  )
                }
              />
              <TextInput
                aria-label={`Image ${index + 1} description`}
                className="control-w-md"
                placeholder="Alt text"
                value={item.description ?? ''}
                onChange={(event) =>
                  onChange(
                    items.map((current, at) =>
                      at === index
                        ? { ...current, description: event.currentTarget.value || undefined }
                        : current,
                    ),
                  )
                }
              />
              <IconButton
                icon="trash"
                tone="ghost"
                size="sm"
                label={`Remove image ${index + 1}`}
                disabled={items.length <= 1}
                onClick={() => onChange(items.filter((_, at) => at !== index))}
              />
            </div>
            {urlError !== undefined ? <p className="row-error">{urlError}</p> : null}
          </div>
        );
      })}

      <Button
        size="sm"
        icon="plus"
        className="ladder-add"
        disabled={items.length >= MEDIA_GALLERY_ITEMS_MAX}
        onClick={() => {
          recent.mark(items.length);
          onChange([...items, { url: '' }]);
        }}
      >
        Add image
      </Button>
    </div>
  );
}

function AccessoryFields({
  guildId,
  accessory,
  taken,
  onChange,
  errors,
  prefix,
}: {
  guildId: string;
  accessory: SectionAccessory;
  taken: ReadonlySet<string>;
  onChange: (next: SectionAccessory) => void;
  errors: ConfigErrors;
  prefix: string;
}): ReactElement {
  const urlError = errors.at(
    accessory.kind === 'thumbnail' ? `${prefix}.accessory.url` : `${prefix}.accessory.button.url`,
  );
  const [switched, setSwitched] = useState(false);

  return (
    <div className="stack stack-10 honeypot-detail-wide">
      <SegmentedControl
        label="Accessory"
        value={accessory.kind}
        options={ACCESSORY}
        onChange={(next) => {
          setSwitched(true);
          onChange(
            next === 'thumbnail'
              ? { kind: 'thumbnail', url: '' }
              : { kind: 'button', button: newLinkButton(taken) },
          );
        }}
      />

      {accessory.kind === 'thumbnail' ? (
        <div key="thumbnail" className={cx('inline inline-8', switched && 'motion-fade')}>
          <TextInput
            aria-label="Accessory image address"
            placeholder="https://…"
            invalid={urlError !== undefined}
            value={accessory.url}
            onChange={(event) => onChange({ ...accessory, url: event.currentTarget.value })}
          />
          <TextInput
            aria-label="Accessory image description"
            className="control-w-md"
            placeholder="Alt text"
            value={accessory.description ?? ''}
            onChange={(event) =>
              onChange({ ...accessory, description: event.currentTarget.value || undefined })
            }
          />
        </div>
      ) : (
        <div key="button" className={cx('stack stack-8', switched && 'motion-fade')}>
          <div className="inline inline-8 inline-wrap">
            <EmojiPicker
              guildId={guildId}
              label="Accessory button emoji"
              value={accessory.button.emoji ?? null}
              onChange={(emoji) =>
                onChange({
                  ...accessory,
                  button: { ...accessory.button, emoji: emoji ?? undefined },
                })
              }
            />
            <TextInput
              aria-label="Accessory button label"
              className="control-w-md"
              placeholder="Label"
              maxLength={BUTTON_LABEL_MAX}
              value={accessory.button.label ?? ''}
              onChange={(event) =>
                onChange({
                  ...accessory,
                  button: { ...accessory.button, label: event.currentTarget.value || undefined },
                })
              }
            />
          </div>
          <TextInput
            aria-label="Accessory button link"
            placeholder="https://…"
            maxLength={BUTTON_URL_MAX}
            invalid={urlError !== undefined}
            value={accessory.button.url ?? ''}
            onChange={(event) =>
              onChange({
                ...accessory,
                button: { ...accessory.button, url: event.currentTarget.value || undefined },
              })
            }
          />
        </div>
      )}

      {urlError !== undefined ? <p className="row-error">{urlError}</p> : null}
    </div>
  );
}

export interface OverriddenText {
  content: string;
  note: ReactNode;
}

function ChildFields({
  guildId,
  child,
  taken,
  onChange,
  errors,
  prefix,
  overriddenAt,
}: {
  guildId: string;
  child: ContainerChild;
  taken: ReadonlySet<string>;
  onChange: (next: ContainerChild) => void;
  errors: ConfigErrors;
  prefix: string;
  overriddenAt: ((path: string) => OverriddenText | undefined) | undefined;
}): ReactElement {
  const recent = useRecent();

  if (child.kind === 'text') {
    const overridden = overriddenAt?.(prefix);

    if (overridden) {
      return (
        <div className="stack stack-6 honeypot-detail-wide">
          <TextArea
            aria-label="Text, replaced when it is posted"
            className="honeypot-overridden"
            rows={4}
            readOnly
            value={overridden.content}
          />
          <p className="row-note">{overridden.note}</p>
        </div>
      );
    }

    return (
      <div className="honeypot-detail-wide">
        <TextArea
          aria-label="Text"
          rows={4}
          invalid={errors.at(`${prefix}.content`) !== undefined}
          value={child.content}
          onChange={(event) => onChange({ ...child, content: event.currentTarget.value })}
        />
      </div>
    );
  }

  if (child.kind === 'separator') {
    return (
      <>
        <div className="row-detail-field">
          <span className="row-detail-label">Draw a line</span>
          <Switch
            label="Draw a line"
            checked={child.divider}
            onChange={(next) => onChange({ ...child, divider: next })}
          />
        </div>
        <div className="row-detail-field">
          <span className="row-detail-label">Space</span>
          <SegmentedControl
            label="Space"
            value={child.spacing}
            options={SPACING}
            onChange={(next) => onChange({ ...child, spacing: next })}
          />
        </div>
      </>
    );
  }

  if (child.kind === 'gallery') {
    return (
      <GalleryFields
        items={child.items}
        errors={errors}
        prefix={prefix}
        onChange={(items) => onChange({ ...child, items })}
      />
    );
  }

  if (child.kind === 'section') {
    return (
      <>
        <div className="stack stack-8 honeypot-detail-wide">
          {child.text.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a line's position in the section is its identity
            <div className={cx('inline inline-8', recent.enter(index))} key={index}>
              <TextInput
                aria-label={`Line ${index + 1}`}
                value={line}
                onChange={(event) =>
                  onChange({
                    ...child,
                    text: child.text.map((current, at) =>
                      at === index ? event.currentTarget.value : current,
                    ),
                  })
                }
              />
              <IconButton
                icon="trash"
                tone="ghost"
                size="sm"
                label={`Remove line ${index + 1}`}
                disabled={child.text.length <= 1}
                onClick={() =>
                  onChange({ ...child, text: child.text.filter((_, at) => at !== index) })
                }
              />
            </div>
          ))}
          <Button
            size="sm"
            icon="plus"
            className="ladder-add"
            disabled={child.text.length >= SECTION_TEXT_MAX}
            onClick={() => {
              recent.mark(child.text.length);
              onChange({ ...child, text: [...child.text, ''] });
            }}
          >
            Add line
          </Button>
        </div>

        <AccessoryFields
          guildId={guildId}
          accessory={child.accessory}
          taken={taken}
          prefix={prefix}
          errors={errors}
          onChange={(accessory) => onChange({ ...child, accessory })}
        />
      </>
    );
  }

  return child.row.kind === 'buttons' ? (
    <LinkButtons
      guildId={guildId}
      row={child.row}
      taken={taken}
      prefix={`${prefix}.row.buttons`}
      errors={errors}
      onChange={(row) => onChange({ ...child, row })}
    />
  ) : (
    <p className="row-error honeypot-detail-wide">
      This row holds a select menu. Proton has no handler for a menu a member picks from here, so
      remove it.
    </p>
  );
}

// Link is the only button style: refineHoneypotLayout refuses any press that reaches Proton.
export function LayoutBuilder({
  guildId,
  value,
  onChange,
  errors,
  prefix,
  overriddenAt,
}: {
  guildId: string;
  value: readonly V2Component[];
  onChange: (next: V2Component[]) => void;
  errors: ConfigErrors;
  prefix: string;
  overriddenAt?: ((path: string) => OverriddenText | undefined) | undefined;
}): ReactElement {
  const taken = takenKeys(value);
  const recent = useRecent();

  const replace = (index: number, next: V2Component): void =>
    onChange(value.map((current, at) => (at === index ? next : current)));

  const detailFor = (component: V2Component, index: number): ReactNode =>
    component.kind === 'container' ? (
      <div className="stack stack-10 honeypot-detail-wide">
        <div className="inline inline-8">
          <span className="row-detail-label">Edge colour</span>
          <ColourPicker
            label="Container edge colour"
            value={component.accentColor ?? HONEYPOT_COLOUR}
            onChange={(next) => replace(index, { ...component, accentColor: next })}
          />
        </div>

        <div className="honeypot-nested">
          {component.children.map((child, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a child's position in the container is its identity
            <div className={cx('stack stack-8', recent.enter(`${index}:${at}`, 'part'))} key={at}>
              <div className="honeypot-item-head">
                {KIND_LABEL[child.kind]}
                <span className="push-right">
                  <IconButton
                    icon="caret-up"
                    tone="ghost"
                    size="sm"
                    label={`Move ${KIND_LABEL[child.kind]} up`}
                    disabled={at === 0}
                    onClick={() =>
                      replace(index, {
                        ...component,
                        children: move(component.children, at, at - 1),
                      })
                    }
                  />
                  <IconButton
                    icon="caret-down"
                    tone="ghost"
                    size="sm"
                    label={`Move ${KIND_LABEL[child.kind]} down`}
                    disabled={at === component.children.length - 1}
                    onClick={() =>
                      replace(index, {
                        ...component,
                        children: move(component.children, at, at + 1),
                      })
                    }
                  />
                  <IconButton
                    icon="trash"
                    tone="ghost"
                    size="sm"
                    label={`Remove ${KIND_LABEL[child.kind]}`}
                    disabled={component.children.length <= 1}
                    onClick={() =>
                      replace(index, {
                        ...component,
                        children: component.children.filter((_, position) => position !== at),
                      })
                    }
                  />
                </span>
              </div>
              <ChildFields
                guildId={guildId}
                child={child}
                taken={taken}
                prefix={`${prefix}.${index}.children.${at}`}
                errors={errors}
                overriddenAt={overriddenAt}
                onChange={(next) =>
                  replace(index, {
                    ...component,
                    children: component.children.map((current, position) =>
                      position === at ? next : current,
                    ),
                  })
                }
              />
            </div>
          ))}
        </div>

        <AddMenu
          label="Add inside"
          kinds={CHILD_KINDS}
          onAdd={(kind) => {
            recent.mark(`${index}:${component.children.length}`);
            replace(index, {
              ...component,
              children: [...component.children, seedChild(kind, taken)],
            });
          }}
        />
      </div>
    ) : (
      <ChildFields
        guildId={guildId}
        child={component}
        taken={taken}
        prefix={`${prefix}.${index}`}
        errors={errors}
        overriddenAt={overriddenAt}
        onChange={(next) => replace(index, next)}
      />
    );

  return (
    <div className="stack stack-10">
      {value.length === 0 ? null : (
        <Rows>
          {value.map((component, index) => {
            const error = errors.under(`${prefix}.${index}`);
            const summary = summarise(component);

            return (
              <ExpandableRow
                // biome-ignore lint/suspicious/noArrayIndexKey: a component's position is its identity
                key={index}
                className={recent.enter(index, 'part')}
                icon={KIND_ICON[component.kind]}
                title={KIND_LABEL[component.kind]}
                defaultOpen={value.length === 1}
                description={
                  error !== undefined ? <span className="text-danger">{error}</span> : summary
                }
                control={
                  <>
                    <IconButton
                      icon="caret-up"
                      tone="ghost"
                      size="sm"
                      label="Move up"
                      disabled={index === 0}
                      onClick={() => onChange(move(value, index, index - 1))}
                    />
                    <IconButton
                      icon="caret-down"
                      tone="ghost"
                      size="sm"
                      label="Move down"
                      disabled={index === value.length - 1}
                      onClick={() => onChange(move(value, index, index + 1))}
                    />
                    <IconButton
                      icon="trash"
                      tone="ghost"
                      size="sm"
                      label="Remove"
                      onClick={() => onChange(value.filter((_, at) => at !== index))}
                    />
                  </>
                }
                detail={() => detailFor(component, index)}
              />
            );
          })}
        </Rows>
      )}

      <div className="inline inline-12">
        <AddMenu
          label="Add component"
          kinds={TOP_KINDS}
          onAdd={(kind) => {
            recent.mark(value.length);
            onChange([
              ...value,
              kind === 'container'
                ? {
                    kind: 'container',
                    accentColor: HONEYPOT_COLOUR,
                    children: [{ kind: 'text', content: '' }],
                  }
                : seedChild(kind, taken),
            ]);
          }}
        />
        <span className="text-xs text-muted">
          {countV2Components(value)} / {V2_COMPONENTS_MAX} components
        </span>
      </div>
    </div>
  );
}
