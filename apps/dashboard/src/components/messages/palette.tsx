import { type ActionRow, actionRowSchema } from '@proton/core';
import {
  COMPONENT_NAME_MAX,
  MAX_SAVED_COMPONENTS,
  type SavedComponent,
} from '@proton/module-messages/config';
import { type ReactElement, useState } from 'react';
import type { DiscordRole } from '../form/fields.tsx';
import { blankButton, RowEditor, usedKeys } from '../message/builder.tsx';
import { Icon } from '../shell/icon.tsx';

export interface PaletteEditorProps {
  components: readonly SavedComponent[];
  onChange: (components: SavedComponent[]) => void;
  roles: readonly DiscordRole[];
}

function blank(index: number): SavedComponent {
  return {
    name: `component-${index + 1}`,
    row: { kind: 'buttons', buttons: [blankButton(new Set())] },
  };
}

export function summariseRow(row: ActionRow): string {
  if (row.kind === 'select') {
    const count = row.select.options.length;
    return `dropdown · ${count} option${count === 1 ? '' : 's'}`;
  }

  return `${row.buttons.length} button${row.buttons.length === 1 ? '' : 's'}`;
}

export function PaletteEditor({ components, onChange, roles }: PaletteEditorProps): ReactElement {
  const [openIndex, setOpenIndex] = useState<number | null>(components.length > 0 ? 0 : null);

  function update(index: number, patch: Partial<SavedComponent>): void {
    onChange(components.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  return (
    <div className="saved-palette panel-wide" data-path="components">
      <p className="field-description">
        Rows of buttons and dropdowns you build once and drop into any template. Inserting one
        copies it, so editing it here never changes a template that already has it, and deleting it
        never empties one.
      </p>

      {components.length === 0 ? (
        <p className="field-empty">
          No saved components. A template can still build its own rows — this is for the ones you
          want on more than one message.
        </p>
      ) : null}

      <ul className="saved-list">
        {components.map((entry, index) => {
          const open = openIndex === index;
          const parsed = actionRowSchema.safeParse(entry.row);
          const failed = new Set(
            parsed.success
              ? []
              : parsed.error.issues.map((i) => `row.${i.path.map(String).join('.')}`),
          );

          return (
            <li
              className="saved-item"
              // biome-ignore lint/suspicious/noArrayIndexKey: the name is edited in place, so it cannot key its own row
              key={`component-${index}`}
            >
              <div className="saved-head">
                <button
                  aria-expanded={open}
                  className="saved-toggle"
                  onClick={() => setOpenIndex(open ? null : index)}
                  type="button"
                >
                  <Icon name={open ? 'caret-up' : 'caret-down'} />
                  <span className="saved-name">{entry.name || 'Unnamed'}</span>
                  <span className="saved-summary">{summariseRow(entry.row)}</span>
                </button>

                <button
                  aria-label={`Remove the ${entry.name || 'unnamed'} component`}
                  className="button button-ghost"
                  onClick={() => {
                    onChange(components.filter((_, i) => i !== index));
                    setOpenIndex(null);
                  }}
                  type="button"
                >
                  <Icon name="trash" />
                </button>
              </div>

              {open ? (
                <div className="saved-edit">
                  <label className="filter">
                    <span>Name</span>
                    <input
                      aria-invalid={entry.name.trim() === ''}
                      maxLength={COMPONENT_NAME_MAX}
                      onChange={(e) => update(index, { name: e.target.value })}
                      type="text"
                      value={entry.name}
                    />
                    <small className="field-description">
                      What this row is called here. Members never see it.
                    </small>
                  </label>

                  <RowEditor
                    row={entry.row}
                    index={index}
                    path="row"
                    invalid={(path) => failed.has(path)}
                    roles={roles}
                    taken={usedKeys([entry.row])}
                    onChange={(row) => update(index, { row })}
                  />

                  {parsed.success ? null : (
                    <ul className="ladder-errors" role="alert">
                      {parsed.error.issues.map((issue) => (
                        <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <button
        className="button button-quiet"
        disabled={components.length >= MAX_SAVED_COMPONENTS}
        onClick={() => {
          onChange([...components, blank(components.length)]);
          setOpenIndex(components.length);
        }}
        type="button"
      >
        {components.length >= MAX_SAVED_COMPONENTS
          ? `Limit of ${MAX_SAVED_COMPONENTS} components reached`
          : 'Add component'}
      </button>
    </div>
  );
}
