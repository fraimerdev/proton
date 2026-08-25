import type { EntitlementTier } from '@proton/core';
import { EMPTY_MESSAGE, liftLegacyMessage, type ProtonMessage } from '@proton/core';
import type { SavedComponent, TemplateSchedule } from '@proton/module-messages/config';
import { TEMPLATE_NAME_MAX } from '@proton/module-messages/config';
import { type ReactElement, useState } from 'react';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import type { DiscordChannel, DiscordRole } from '../form/fields.tsx';
import { MessageBuilder } from '../message/builder.tsx';
import { messageFrom } from '../message/normalise.ts';
import { MessagePreview } from '../message/preview.tsx';
import { Icon } from '../shell/icon.tsx';
import { ScheduleEditor } from './schedule.tsx';

export interface SavedMessageEntry extends ProtonMessage {
  name: string;
  schedule?: TemplateSchedule | undefined;
}

export interface TemplatesEditorProps {
  templates: readonly SavedMessageEntry[];
  onChange: (templates: SavedMessageEntry[]) => void;
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  tier: EntitlementTier;
  palette?: readonly SavedComponent[];
}

function blank(index: number): SavedMessageEntry {
  return { ...EMPTY_MESSAGE, name: `message-${index + 1}`, content: 'Hello world' };
}

function normalise(value: unknown, index: number): SavedMessageEntry {
  const lifted = liftLegacyMessage(value);
  const name = (lifted as { name?: unknown })?.name;

  const schedule = (lifted as { schedule?: TemplateSchedule })?.schedule;

  return {
    name: typeof name === 'string' ? name : `message-${index + 1}`,
    ...messageFrom(lifted),

    // messageFrom only knows the Discord message; the schedule rides alongside it and would be
    // dropped on every edit without this.
    ...(schedule ? { schedule } : {}),
  };
}

function summarise(message: SavedMessageEntry): string {
  const parts: string[] = [];

  if (message.schedule) parts.push(message.schedule.mode === 'repeat' ? 'repeats' : 'scheduled');

  if (message.v2.length > 0) return [...parts, 'layout'].join(' · ');

  if (message.content?.trim()) parts.push('text');
  if (message.embeds.length > 0) {
    parts.push(`${message.embeds.length} embed${message.embeds.length === 1 ? '' : 's'}`);
  }
  if (message.components.length > 0) {
    parts.push(`${message.components.length} row${message.components.length === 1 ? '' : 's'}`);
  }

  return parts.length > 0 ? parts.join(' · ') : 'empty';
}

export function TemplatesEditor({
  templates,
  onChange,
  channels,
  roles,
  tier,
  palette = [],
}: TemplatesEditorProps): ReactElement {
  const messages = templates.map(normalise);
  const ceiling = listCeiling(tier, 'savedTemplates');

  // Held as an index rather than a name, because the name is edited in this very pane and a
  // selection keyed on it would jump to another template on the first keystroke.
  const [selected, setSelected] = useState(0);
  const open = messages[selected];

  function update(patch: Partial<SavedMessageEntry>): void {
    onChange(messages.map((message, i) => (i === selected ? { ...message, ...patch } : message)));
  }

  function remove(index: number): void {
    onChange(messages.filter((_, i) => i !== index));
    setSelected(index > 0 ? index - 1 : 0);
  }

  function add(): void {
    onChange([...messages, blank(messages.length)]);
    setSelected(messages.length);
  }

  return (
    <div className="templates panel-wide">
      <p className="field-description">
        A template is posted into a channel with <code>/message post</code>. It can carry text, up
        to ten embeds and up to five rows of buttons or dropdowns.
      </p>

      <div className="pane">
        <div className="pane-list">
          <ul className="pane-items">
            {messages.map((message, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: the name is edited in place, so it cannot key its own row
                key={`template-${index}`}
              >
                <button
                  aria-current={index === selected ? 'true' : undefined}
                  className="pane-item"
                  onClick={() => setSelected(index)}
                  type="button"
                >
                  <span className="pane-item-name">{message.name || 'Unnamed'}</span>
                  <span className="pane-item-meta">{summarise(message)}</span>
                </button>
              </li>
            ))}
          </ul>

          <button
            className="pane-add"
            disabled={messages.length >= ceiling}
            onClick={add}
            type="button"
          >
            <Icon name="plus" />
            {messages.length >= ceiling ? ceilingNote(tier, 'savedTemplates') : 'New template'}
          </button>
        </div>

        {open ? (
          <div className="pane-edit">
            <div className="pane-edit-head">
              <label className="filter">
                <span>Name</span>
                <input
                  aria-invalid={open.name.trim() === ''}
                  maxLength={TEMPLATE_NAME_MAX}
                  onChange={(e) => update({ name: e.target.value })}
                  type="text"
                  value={open.name}
                />
                <small className="field-description">
                  What <code>/message post</code> asks for. It also keys any button on this message,
                  so renaming it stops presses on a message already posted.
                </small>
              </label>

              <button
                aria-label={`Remove the ${open.name || 'unnamed'} template`}
                className="button button-ghost"
                onClick={() => remove(selected)}
                type="button"
              >
                <Icon name="trash" />
              </button>
            </div>

            <ScheduleEditor
              channels={channels}
              onChange={(schedule) => update({ schedule })}
              roles={roles}
              schedule={open.schedule}
            />

            <div className="pane-body">
              <MessageBuilder
                channels={channels}
                message={open}
                onChange={(next) => update(next)}
                palette={palette}
                roles={roles}
              />

              <div className="pane-preview">
                <MessagePreview channels={channels} message={open} roles={roles} />
              </div>
            </div>
          </div>
        ) : (
          <div className="pane-edit">
            <p className="field-empty">
              No templates yet. <code>/message send</code> still composes a one-off message without
              saving it.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
