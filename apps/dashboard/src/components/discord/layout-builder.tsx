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
  MEDIA_DESCRIPTION_MAX,
  MEDIA_GALLERY_ITEMS_MAX,
  SECTION_TEXT_MAX,
  V2_COMPONENTS_MAX,
} from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { PresenceList, useRecent } from '../ui/collection.tsx';
import {
  Button,
  cx,
  IconButton,
  SegmentedControl,
  type SegmentedOption,
  Switch,
  TextArea,
} from '../ui/controls.tsx';
import type { IconName } from '../ui/icon.tsx';
import { ExpandableRow, Rows } from '../ui/layout.tsx';
import { MENU_ITEM, menuItemFor, Popover } from '../ui/overlay.tsx';
import {
  blank,
  type ConfigErrors,
  MessageField,
  OptionalColour,
  type PlaceholderSlot,
  sentence,
} from './embed-editor.tsx';
import { EmojiPicker } from './emoji-picker.tsx';
import { DEFAULT_EMBED_COLOUR } from './inputs.tsx';

type Kind = V2Component['kind'];
type ChildKind = ContainerChild['kind'];
type ButtonRow = Extract<ActionRow, { kind: 'buttons' }>;

export const KIND_LABEL: Record<Kind, string> = {
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

export const TOP_KINDS: readonly Kind[] = [
  'container',
  'text',
  'separator',
  'gallery',
  'section',
  'row',
];

export const CHILD_KINDS: readonly ChildKind[] = ['text', 'separator', 'gallery', 'section', 'row'];

const SELECT_REFUSAL =
  'This row is a dropdown, and Proton does not respond to a choice made in this message. Remove it.';

export interface OverriddenText {
  content: string;
  note: ReactNode;
}

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

export function newLinkButton(taken: ReadonlySet<string>): MessageButton {
  let index = 1;
  while (taken.has(`link${index}`)) index += 1;

  return { key: `link${index}`, style: 'link', label: 'Open', url: '' };
}

export function seedChild(kind: ChildKind, taken: ReadonlySet<string>): ContainerChild {
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

export function seedComponent(
  kind: Kind,
  taken: ReadonlySet<string>,
  accent: number | undefined,
): V2Component {
  if (kind !== 'container') return seedChild(kind, taken);

  return {
    kind: 'container',
    ...(accent === undefined ? {} : { accentColor: accent }),
    children: [{ kind: 'text', content: '' }],
  };
}

export function summariseComponent(component: V2Component): string | undefined {
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

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
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
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>(MENU_ITEM)?.focus({ preventScroll: true });
  }, [open]);

  return (
    <>
      <Button
        ref={anchor}
        size="sm"
        icon="plus"
        trailingIcon="caret-down"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} minWidth={220}>
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              event.preventDefault();
              setOpen(false);
              return;
            }

            const items = [...(menu.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? [])];
            const target = menuItemFor(items, event.key);
            if (target === undefined) return;
            event.preventDefault();
            target.focus();
          }}
        >
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onAdd(kind);
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

function StyleRepair({
  button,
  error,
  onRepair,
}: {
  button: MessageButton;
  error: string | undefined;
  onRepair: () => void;
}): ReactElement | null {
  if (button.style === 'link') return null;

  return (
    <>
      {error !== undefined ? <p className="row-error">{sentence(error)}</p> : null}
      <Button size="sm" className="ladder-add" onClick={onRepair}>
        Change to link button
      </Button>
    </>
  );
}

interface FieldContext {
  guildId: string;
  taken: ReadonlySet<string>;
  errors: ConfigErrors;
  placeholders: PlaceholderSlot | undefined;
}

function LinkButtonRow({
  guildId,
  taken,
  errors,
  placeholders,
  row,
  path,
  onChange,
}: FieldContext & {
  row: ButtonRow;
  path: string;
  onChange: (next: ButtonRow) => void;
}): ReactElement {
  const recent = useRecent();

  const set = (index: number, next: MessageButton): void =>
    onChange({
      kind: 'buttons',
      buttons: row.buttons.map((button, at) => (at === index ? next : button)),
    });

  return (
    <div className="panel-sunken stack stack-12 message-detail-wide">
      <PresenceList>
        {row.buttons.map((button, index) => {
          const at = `${path}.${index}`;

          return (
            <div className={cx('stack stack-8', recent.enter(button.key, 'part'))} key={button.key}>
              <div className="inline inline-8 inline-wrap message-field-row">
                <EmojiPicker
                  guildId={guildId}
                  label={`Button ${index + 1} emoji`}
                  value={button.emoji ?? null}
                  onChange={(emoji) => set(index, { ...button, emoji: emoji ?? undefined })}
                />
                <MessageField
                  placeholders={placeholders}
                  path={`${at}.label`}
                  label={`Button ${index + 1} label`}
                  placeholder="Label"
                  width="md"
                  maxLength={BUTTON_LABEL_MAX}
                  value={button.label ?? ''}
                  error={errors.at(`${at}.label`)}
                  onChange={(next) => set(index, { ...button, label: blank(next) })}
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
                        buttons: row.buttons.filter((_, position) => position !== index),
                      })
                    }
                  />
                </span>
              </div>

              <MessageField
                placeholders={placeholders}
                path={`${at}.url`}
                label={`Button ${index + 1} link`}
                link
                placeholder="https://…"
                maxLength={BUTTON_URL_MAX}
                value={button.url ?? ''}
                error={errors.at(`${at}.url`)}
                onChange={(next) => set(index, { ...button, url: blank(next) })}
              />

              <StyleRepair
                button={button}
                error={errors.at(`${at}.style`) ?? errors.at(`${at}.action`)}
                onRepair={() => set(index, { ...button, style: 'link', action: undefined })}
              />
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
  errors,
  placeholders,
  items,
  path,
  onChange,
}: FieldContext & {
  items: readonly MediaItem[];
  path: string;
  onChange: (next: MediaItem[]) => void;
}): ReactElement {
  const recent = useRecent();

  const set = (index: number, next: MediaItem): void =>
    onChange(items.map((current, at) => (at === index ? next : current)));

  return (
    <div className="stack stack-8 message-detail-wide">
      {items.map((item, index) => {
        const at = `${path}.items.${index}`;

        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: an image's position in the gallery is its identity
            key={index}
            className={cx('inline inline-8 message-field-row', recent.enter(index))}
          >
            <MessageField
              placeholders={placeholders}
              path={`${at}.url`}
              label={`Image ${index + 1} address`}
              link
              layout="grow"
              placeholder="https://…"
              value={item.url}
              error={errors.at(`${at}.url`)}
              onChange={(next) => set(index, { ...item, url: next })}
            />
            <MessageField
              placeholders={placeholders}
              path={`${at}.description`}
              label={`Image ${index + 1} description`}
              placeholder="Alt text"
              width="md"
              maxLength={MEDIA_DESCRIPTION_MAX}
              value={item.description ?? ''}
              error={errors.at(`${at}.description`)}
              onChange={(next) => set(index, { ...item, description: blank(next) })}
            />
            <IconButton
              icon="trash"
              tone="ghost"
              size="sm"
              label={`Remove image ${index + 1}`}
              disabled={items.length <= 1}
              onClick={() => onChange(items.filter((_, position) => position !== index))}
            />
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
  taken,
  errors,
  placeholders,
  accessory,
  path,
  onChange,
}: FieldContext & {
  accessory: SectionAccessory;
  path: string;
  onChange: (next: SectionAccessory) => void;
}): ReactElement {
  const [switched, setSwitched] = useState(false);
  const at = `${path}.accessory`;

  return (
    <div className="stack stack-10 message-detail-wide">
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
        <div
          key="thumbnail"
          className={cx('inline inline-8 message-field-row', switched && 'motion-fade')}
        >
          <MessageField
            placeholders={placeholders}
            path={`${at}.url`}
            label="Accessory image address"
            link
            layout="grow"
            placeholder="https://…"
            value={accessory.url}
            error={errors.at(`${at}.url`)}
            onChange={(next) => onChange({ ...accessory, url: next })}
          />
          <MessageField
            placeholders={placeholders}
            path={`${at}.description`}
            label="Accessory image description"
            placeholder="Alt text"
            width="md"
            maxLength={MEDIA_DESCRIPTION_MAX}
            value={accessory.description ?? ''}
            error={errors.at(`${at}.description`)}
            onChange={(next) => onChange({ ...accessory, description: blank(next) })}
          />
        </div>
      ) : (
        <div key="button" className={cx('stack stack-8', switched && 'motion-fade')}>
          <div className="inline inline-8 inline-wrap message-field-row">
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
            <MessageField
              placeholders={placeholders}
              path={`${at}.button.label`}
              label="Accessory button label"
              placeholder="Label"
              width="md"
              maxLength={BUTTON_LABEL_MAX}
              value={accessory.button.label ?? ''}
              error={errors.at(`${at}.button.label`)}
              onChange={(next) =>
                onChange({ ...accessory, button: { ...accessory.button, label: blank(next) } })
              }
            />
          </div>
          <MessageField
            placeholders={placeholders}
            path={`${at}.button.url`}
            label="Accessory button link"
            link
            placeholder="https://…"
            maxLength={BUTTON_URL_MAX}
            value={accessory.button.url ?? ''}
            error={errors.at(`${at}.button.url`)}
            onChange={(next) =>
              onChange({ ...accessory, button: { ...accessory.button, url: blank(next) } })
            }
          />
          <StyleRepair
            button={accessory.button}
            error={errors.at(`${at}.button.style`) ?? errors.at(`${at}.button.action`)}
            onRepair={() =>
              onChange({
                ...accessory,
                button: { ...accessory.button, style: 'link', action: undefined },
              })
            }
          />
        </div>
      )}
    </div>
  );
}

function ChildFields({
  child,
  path,
  overriddenAt,
  onChange,
  ...context
}: FieldContext & {
  child: ContainerChild;
  path: string;
  overriddenAt: ((path: string) => OverriddenText | undefined) | undefined;
  onChange: (next: ContainerChild) => void;
}): ReactElement {
  const recent = useRecent();
  const { errors, placeholders } = context;

  if (child.kind === 'text') {
    const overridden = overriddenAt?.(path);

    if (overridden !== undefined) {
      return (
        <div className="stack stack-6 message-detail-wide">
          <TextArea
            aria-label="Text, replaced when it is posted"
            className="layout-overridden"
            rows={4}
            readOnly
            value={overridden.content}
          />
          <p className="row-note">{overridden.note}</p>
        </div>
      );
    }

    return (
      <MessageField
        placeholders={placeholders}
        path={`${path}.content`}
        label="Text"
        rows={4}
        layout="wide"
        value={child.content}
        error={errors.at(`${path}.content`)}
        empty="Write some text, or remove this."
        onChange={(next) => onChange({ ...child, content: next })}
      />
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
        {...context}
        items={child.items}
        path={path}
        onChange={(items) => onChange({ ...child, items })}
      />
    );
  }

  if (child.kind === 'section') {
    return (
      <>
        <div className="stack stack-8 message-detail-wide">
          {child.text.map((line, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a line's position in the section is its identity
              key={index}
              className={cx('inline inline-8 message-field-row', recent.enter(index))}
            >
              <MessageField
                placeholders={placeholders}
                path={`${path}.text.${index}`}
                label={`Line ${index + 1}`}
                layout="grow"
                value={line}
                error={errors.at(`${path}.text.${index}`)}
                empty="A line needs text, or remove it."
                onChange={(next) =>
                  onChange({
                    ...child,
                    text: child.text.map((current, at) => (at === index ? next : current)),
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
          {...context}
          accessory={child.accessory}
          path={path}
          onChange={(accessory) => onChange({ ...child, accessory })}
        />
      </>
    );
  }

  return child.row.kind === 'buttons' ? (
    <LinkButtonRow
      {...context}
      row={child.row}
      path={`${path}.row.buttons`}
      onChange={(row) => onChange({ ...child, row })}
    />
  ) : (
    <p className="row-error message-detail-wide">{SELECT_REFUSAL}</p>
  );
}

export interface LayoutBuilderProps {
  guildId: string;
  value: readonly V2Component[];
  onChange: (next: V2Component[]) => void;
  errors: ConfigErrors;
  prefix: string;
  taken?: ReadonlySet<string> | undefined;
  accent?: number | undefined;
  overriddenAt?: ((path: string) => OverriddenText | undefined) | undefined;
  placeholders?: PlaceholderSlot | undefined;
}

export function LayoutBuilder({
  guildId,
  value,
  onChange,
  errors,
  prefix,
  taken: given,
  accent,
  overriddenAt,
  placeholders,
}: LayoutBuilderProps): ReactElement {
  const recent = useRecent();
  const taken = given ?? takenKeys(value);
  const context: FieldContext = { guildId, taken, errors, placeholders };

  const replace = (index: number, next: V2Component): void =>
    onChange(value.map((current, at) => (at === index ? next : current)));

  const detailFor = (component: V2Component, index: number): ReactNode => {
    if (component.kind !== 'container') {
      return (
        <ChildFields
          {...context}
          child={component}
          path={`${prefix}.${index}`}
          overriddenAt={overriddenAt}
          onChange={(next) => replace(index, next)}
        />
      );
    }

    const { children } = component;
    const setChildren = (next: ContainerChild[]): void =>
      replace(index, { ...component, children: next });

    return (
      <div className="stack stack-10 message-detail-wide">
        <div className="inline inline-8">
          <span className="row-detail-label">Edge colour</span>
          <OptionalColour
            label="Container edge colour"
            value={component.accentColor}
            fallback={accent ?? DEFAULT_EMBED_COLOUR}
            onChange={(next) => replace(index, { ...component, accentColor: next })}
          />
        </div>

        <div className="layout-nested">
          {children.map((child, at) => {
            const label = KIND_LABEL[child.kind];

            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: a child's position in the container is its identity
                key={at}
                className={cx('stack stack-8', recent.enter(`${index}:${at}`, 'part'))}
              >
                <div className="layout-item-head">
                  {label}
                  <span className="push-right">
                    <IconButton
                      icon="caret-up"
                      tone="ghost"
                      size="sm"
                      label={`Move ${label} up`}
                      disabled={at === 0}
                      onClick={() => setChildren(moveItem(children, at, at - 1))}
                    />
                    <IconButton
                      icon="caret-down"
                      tone="ghost"
                      size="sm"
                      label={`Move ${label} down`}
                      disabled={at === children.length - 1}
                      onClick={() => setChildren(moveItem(children, at, at + 1))}
                    />
                    <IconButton
                      icon="trash"
                      tone="ghost"
                      size="sm"
                      label={`Remove ${label}`}
                      disabled={children.length <= 1}
                      onClick={() => setChildren(children.filter((_, position) => position !== at))}
                    />
                  </span>
                </div>
                <ChildFields
                  {...context}
                  child={child}
                  path={`${prefix}.${index}.children.${at}`}
                  overriddenAt={overriddenAt}
                  onChange={(next) =>
                    setChildren(
                      children.map((current, position) => (position === at ? next : current)),
                    )
                  }
                />
              </div>
            );
          })}
        </div>

        <AddMenu
          label="Add inside"
          kinds={CHILD_KINDS}
          onAdd={(kind) => {
            recent.mark(`${index}:${children.length}`);
            setChildren([...children, seedChild(kind, taken)]);
          }}
        />
      </div>
    );
  };

  return (
    <div className="stack stack-10">
      {value.length === 0 ? null : (
        <Rows>
          {value.map((component, index) => {
            const error = errors.under(`${prefix}.${index}`);

            return (
              <ExpandableRow
                // biome-ignore lint/suspicious/noArrayIndexKey: a component's position is its identity
                key={index}
                className={recent.enter(index, 'part')}
                icon={KIND_ICON[component.kind]}
                title={KIND_LABEL[component.kind]}
                defaultOpen={value.length === 1 || recent.has(index)}
                description={
                  error !== undefined ? (
                    <span className="text-danger">{sentence(error)}</span>
                  ) : (
                    summariseComponent(component)
                  )
                }
                control={
                  <>
                    <IconButton
                      icon="caret-up"
                      tone="ghost"
                      size="sm"
                      label="Move up"
                      disabled={index === 0}
                      onClick={() => onChange(moveItem(value, index, index - 1))}
                    />
                    <IconButton
                      icon="caret-down"
                      tone="ghost"
                      size="sm"
                      label="Move down"
                      disabled={index === value.length - 1}
                      onClick={() => onChange(moveItem(value, index, index + 1))}
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
            onChange([...value, seedComponent(kind, taken, accent)]);
          }}
        />
        <span className="text-xs text-muted">
          {countV2Components(value)} / {V2_COMPONENTS_MAX} components
        </span>
      </div>
    </div>
  );
}
