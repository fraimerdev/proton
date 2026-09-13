import type { ContainerChild, MediaItem, SectionAccessory, V2Component } from '@proton/core';
import {
  BUTTON_LABEL_MAX,
  BUTTON_URL_MAX,
  countV2Components,
  MEDIA_GALLERY_ITEMS_MAX,
  SECTION_TEXT_MAX,
  V2_COMPONENTS_MAX,
} from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import { useRef, useState } from 'react';
import { EmojiPicker } from '../../components/discord/emoji-picker.tsx';
import { ColourPicker, DEFAULT_EMBED_COLOUR } from '../../components/discord/inputs.tsx';
import { useRecent } from '../../components/ui/collection.tsx';
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
import { LinkButtonRowEditor, newLinkButton } from './buttons.tsx';
import type { ConfigErrors } from './errors.ts';

type ChildKind = ContainerChild['kind'];
type Kind = V2Component['kind'];

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

const TOP_KINDS: readonly Kind[] = ['text', 'separator', 'gallery', 'section', 'row', 'container'];
const CHILD_KINDS: readonly ChildKind[] = ['text', 'separator', 'gallery', 'section', 'row'];

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

function GalleryFields({
  items,
  onChange,
}: {
  items: readonly MediaItem[];
  onChange: (next: MediaItem[]) => void;
}): ReactElement {
  const recent = useRecent();

  return (
    <div className="stack stack-8 welcome-detail-wide">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: an image's position in the gallery is its identity
        <div className={cx('inline inline-8', recent.enter(index))} key={index}>
          <TextInput
            aria-label={`Image ${index + 1} address`}
            placeholder="https://…"
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
      ))}

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
  const urlError = errors.at(`${prefix}.accessory.button.url`);
  const [switched, setSwitched] = useState(false);

  return (
    <div className="stack stack-10 welcome-detail-wide">
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
          {urlError !== undefined ? <p className="row-error">{urlError}</p> : null}
        </div>
      )}
    </div>
  );
}

function ChildFields({
  guildId,
  child,
  taken,
  onChange,
  errors,
  prefix,
  selectRefusal,
}: {
  guildId: string;
  child: ContainerChild;
  taken: ReadonlySet<string>;
  onChange: (next: ContainerChild) => void;
  errors: ConfigErrors;
  prefix: string;
  selectRefusal: string | undefined;
}): ReactElement | null {
  const recent = useRecent();

  if (child.kind === 'text') {
    return (
      <div className="welcome-detail-wide">
        <TextArea
          aria-label="Text"
          rows={3}
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
      <GalleryFields items={child.items} onChange={(items) => onChange({ ...child, items })} />
    );
  }

  if (child.kind === 'section') {
    return (
      <>
        <div className="stack stack-8 welcome-detail-wide">
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
    <div className="welcome-detail-wide">
      <LinkButtonRowEditor
        guildId={guildId}
        row={child.row}
        taken={taken}
        prefix={`${prefix}.row.buttons`}
        errorAt={errors.at}
        onChange={(row) => onChange({ ...child, row })}
        onRemove={() => onChange({ ...child, row: { kind: 'buttons', buttons: [] } })}
      />
    </div>
  ) : selectRefusal === undefined ? null : (
    <p className="row-error welcome-detail-wide">{selectRefusal}</p>
  );
}

export function LayoutBuilder({
  guildId,
  value,
  taken,
  onChange,
  errors,
  prefix,
}: {
  guildId: string;
  value: readonly V2Component[];
  taken: ReadonlySet<string>;
  onChange: (next: V2Component[]) => void;
  errors: ConfigErrors;
  prefix: string;
}): ReactElement {
  const recent = useRecent();

  const replace = (index: number, next: V2Component): void =>
    onChange(value.map((current, at) => (at === index ? next : current)));

  // The schema refuses an interactive component at the layout's own path, not at the row's.
  const selectRefusal = errors.at(prefix);

  const detailFor = (component: V2Component, index: number): ReactNode =>
    component.kind === 'container' ? (
      <div className="stack stack-10 welcome-detail-wide">
        <div className="inline inline-8">
          <span className="row-detail-label">Edge colour</span>
          <ColourPicker
            label="Container edge colour"
            value={component.accentColor ?? DEFAULT_EMBED_COLOUR}
            onChange={(next) => replace(index, { ...component, accentColor: next })}
          />
        </div>

        <div className="welcome-nested">
          {component.children.map((child, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a child's position in the container is its identity
            <div className={cx('stack stack-8', recent.enter(`${index}:${at}`, 'part'))} key={at}>
              <div className="welcome-item-head">
                {KIND_LABEL[child.kind]}
                <span className="push-right">
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
                selectRefusal={selectRefusal}
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
        selectRefusal={selectRefusal}
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
                ? { kind: 'container', children: [{ kind: 'text', content: '' }] }
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
