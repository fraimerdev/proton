import type { EntitlementTier } from '@proton/core';
import {
  blankPanel,
  PANEL_ID_MAX,
  PANEL_STYLES,
  type PanelStyle,
  TEXT_CHANNEL_TYPE,
  type TicketPanel,
  type TicketType,
  ticketPanelsSchema,
} from '@proton/module-tickets/config';
import { type ReactElement, useId, useState } from 'react';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import {
  channelOptions,
  type DiscordChannel,
  type PickerOption,
  SinglePicker,
  TokenPicker,
} from '../form/picker.tsx';
import { Icon } from '../shell/icon.tsx';

export interface TicketPanelsEditorProps {
  panels: readonly Partial<TicketPanel>[];
  types: readonly Partial<TicketType>[];
  channels: readonly DiscordChannel[];
  tier: EntitlementTier;
  onChange: (panels: TicketPanel[]) => void;
}

const PANEL_DEFAULTS = blankPanel(0);

// A stored row filled out to the current shape, for the same reason the ticket-type editor does it:
// a row that reached the editor unparsed would crash on `panel.typeIds`.
function complete(panel: Partial<TicketPanel>): TicketPanel {
  return {
    ...PANEL_DEFAULTS,
    ...panel,
    id: panel.id ?? '',
    channelId: panel.channelId ?? '',
    typeIds: panel.typeIds ?? [],
  };
}

const STYLE_LABELS: Record<PanelStyle, string> = {
  buttons: 'A button for each ticket type',
  select: 'One dropdown listing the ticket types',
};

const HEX = /^#?[0-9a-fA-F]{6}$/;

function hexText(colour: number | undefined): string {
  return colour === undefined ? '' : `#${colour.toString(16).padStart(6, '0')}`;
}

function fromHex(raw: string): number | undefined {
  const value = raw.trim();
  return HEX.test(value) ? Number.parseInt(value.replace('#', ''), 16) : undefined;
}

function describeIssuePath(path: readonly PropertyKey[]): string {
  return typeof path[0] === 'number' ? `Panel ${path[0] + 1}: ` : '';
}

function summarise(panel: TicketPanel, missing: readonly string[]): string {
  if (missing.length > 0) return `${missing.length} missing type${missing.length === 1 ? '' : 's'}`;

  const count = panel.typeIds.length;
  const kinds = count === 0 ? 'no types' : `${count} type${count === 1 ? '' : 's'}`;

  return `${panel.style === 'select' ? 'dropdown' : 'buttons'} · ${kinds}`;
}

interface ColourInputProps {
  colour: number | undefined;
  onChange: (colour: number | undefined) => void;
}

function ColourInput({ colour, onChange }: ColourInputProps): ReactElement {
  const errorId = useId();
  const [seen, setSeen] = useState(colour);
  const [draft, setDraft] = useState(() => hexText(colour));

  // Held, not derived: a controlled hex field reverts every keystroke before the sixth.
  if (seen !== colour) {
    setSeen(colour);
    setDraft(hexText(colour));
  }

  const wrong = draft.trim() !== '' && fromHex(draft) === undefined;

  return (
    <span className="builder-colour">
      <label className="filter">
        <span>Colour</span>
        <input
          type="color"
          value={colour === undefined ? '#000000' : hexText(colour)}
          onChange={(e) => {
            setDraft(e.target.value);
            onChange(fromHex(e.target.value));
          }}
        />
      </label>

      <label className="filter">
        <span>Hex</span>
        <input
          type="text"
          value={draft}
          placeholder="#5865F2"
          spellCheck={false}
          aria-invalid={wrong}
          aria-describedby={wrong ? errorId : undefined}
          onBlur={() => setDraft(hexText(colour))}
          onChange={(e) => {
            setDraft(e.target.value);

            if (e.target.value.trim() === '') onChange(undefined);
            else {
              const parsed = fromHex(e.target.value);
              if (parsed !== undefined) onChange(parsed);
            }
          }}
        />
      </label>

      <button
        type="button"
        className="button button-ghost"
        disabled={colour === undefined && draft === ''}
        onClick={() => {
          setDraft('');
          onChange(undefined);
        }}
      >
        No colour
      </button>

      {wrong ? (
        <span className="field-error" id={errorId} role="alert">
          A colour is six hex digits, like #5865F2. The colour above stays until this reads as one.
        </span>
      ) : null}
    </span>
  );
}

interface PanelDetailProps {
  panel: TicketPanel;
  typeChoices: readonly PickerOption[];
  missing: readonly string[];
  textChoices: readonly PickerOption[];
  invalid: (field: string) => boolean;
  onChange: (patch: Partial<TicketPanel>) => void;
}

function PanelDetail({
  panel,
  typeChoices,
  missing,
  textChoices,
  invalid,
  onChange,
}: PanelDetailProps): ReactElement {
  const fieldId = useId();

  // A label wrapping the picker would forward option clicks back to the trigger and reopen it.
  const id = (part: string): string => `${fieldId}-${part}`;

  return (
    <div className="saved-edit">
      <label className="filter">
        <span>Id</span>
        <input
          type="text"
          maxLength={PANEL_ID_MAX}
          value={panel.id}
          aria-invalid={panel.id === ''}
          onChange={(e) => onChange({ id: e.target.value })}
        />
        <small className="field-description">
          What <code>/ticket panel</code> asks for, and what every button on a posted panel carries
          back. Renaming it stops presses on the panel already in the channel.
        </small>
      </label>

      <label className="filter">
        <span>Name</span>
        <input
          type="text"
          maxLength={64}
          value={panel.name}
          aria-invalid={panel.name.trim() === ''}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </label>

      <div className="filter">
        <span>
          <label htmlFor={id('channel')}>Panel lives in</label>
        </span>
        <SinglePicker
          id={id('channel')}
          label="Panel lives in"
          options={textChoices}
          value={panel.channelId === '' ? null : panel.channelId}
          onChange={(next) => onChange({ channelId: next ?? '' })}
          emptyLabel="Choose a channel…"
          clearable={false}
          invalid={panel.channelId === ''}
        />
      </div>

      <label className="filter">
        <span>Members choose with</span>
        <select
          value={panel.style}
          onChange={(e) => onChange({ style: e.target.value as PanelStyle })}
        >
          {PANEL_STYLES.map((style) => (
            <option key={style} value={style}>
              {STYLE_LABELS[style]}
            </option>
          ))}
        </select>
      </label>

      <div className="filter">
        <span>Ticket types this panel offers</span>
        <TokenPicker
          label="Ticket types this panel offers"
          options={typeChoices}
          values={panel.typeIds}
          max={25}
          onChange={(typeIds) => onChange({ typeIds })}
        />

        {missing.length > 0 ? (
          <span className="field-error" role="alert">
            {missing.length === 1
              ? `This panel offers “${missing[0]}”, which is not a ticket type this server has.`
              : `This panel offers ${missing.length} ticket types this server does not have: ${missing.join(', ')}.`}{' '}
            Pressing that option tells the member the option is gone and opens nothing. Remove it,
            or add the type back under Ticket types.
          </span>
        ) : panel.typeIds.length === 0 ? (
          <span className="field-error" role="alert">
            This panel offers nothing, so pressing it opens no ticket. Attach at least one ticket
            type.
          </span>
        ) : null}

        {typeChoices.length === 0 ? (
          <small className="field-description">
            The list holds the ticket types this server has saved. A type added above is offered
            here after the next save.
          </small>
        ) : null}
      </div>

      {panel.style === 'select' ? (
        <label className="filter">
          <span>The dropdown says</span>
          <input
            type="text"
            maxLength={150}
            placeholder="Choose what you need help with"
            value={panel.selectPlaceholder ?? ''}
            onChange={(e) =>
              onChange({ selectPlaceholder: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </label>
      ) : null}

      <fieldset className="builder-section">
        <legend>How the panel looks</legend>

        <label className="filter">
          <span>Title</span>
          <input
            type="text"
            maxLength={256}
            value={panel.title ?? ''}
            onChange={(e) =>
              onChange({ title: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </label>

        <label className="filter">
          <span>Panel text</span>
          <textarea
            rows={3}
            maxLength={2000}
            value={panel.panelText}
            aria-invalid={panel.panelText.trim() === ''}
            onChange={(e) => onChange({ panelText: e.target.value })}
          />
        </label>

        <ColourInput colour={panel.colour} onChange={(colour) => onChange({ colour })} />

        <label className="filter">
          <span>Author line</span>
          <input
            type="text"
            maxLength={256}
            value={panel.authorName ?? ''}
            onChange={(e) =>
              onChange({ authorName: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </label>

        <label className="filter">
          <span>Footer</span>
          <input
            type="text"
            maxLength={2048}
            value={panel.footerText ?? ''}
            onChange={(e) =>
              onChange({ footerText: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </label>

        <label className="filter">
          <span>Thumbnail</span>
          <input
            type="url"
            maxLength={2000}
            placeholder="https://"
            value={panel.thumbnailUrl ?? ''}
            aria-invalid={invalid('thumbnailUrl')}
            onChange={(e) =>
              onChange({ thumbnailUrl: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </label>

        <label className="filter">
          <span>Image</span>
          <input
            type="url"
            maxLength={2000}
            placeholder="https://"
            value={panel.imageUrl ?? ''}
            aria-invalid={invalid('imageUrl')}
            onChange={(e) =>
              onChange({ imageUrl: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </label>
      </fieldset>
    </div>
  );
}

export function TicketPanelsEditor({
  panels: stored,
  types,
  channels,
  tier,
  onChange,
}: TicketPanelsEditorProps): ReactElement {
  const ceiling = listCeiling(tier, 'ticketPanels');
  const panels = stored.map(complete);
  const parsed = ticketPanelsSchema.safeParse(panels);

  const [openIndex, setOpenIndex] = useState<number | null>(panels.length > 0 ? 0 : null);

  const failed = new Set(
    parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
  );

  const textChoices = channelOptions(channels, [TEXT_CHANNEL_TYPE]);
  const typeChoices: PickerOption[] = types.flatMap((type) =>
    type.id === undefined ? [] : [{ id: type.id, label: type.name ?? type.id }],
  );
  const known = new Set(typeChoices.map((choice) => choice.id));

  function update(index: number, patch: Partial<TicketPanel>): void {
    onChange(panels.map((panel, i) => (i === index ? { ...panel, ...patch } : panel)));
  }

  return (
    <div className="ladder" data-path="panels">
      <p className="field-description">
        A panel is one message members open tickets from. It offers the ticket types you attach to
        it, as buttons or as a dropdown. Post it, or refresh it after a change, with{' '}
        <code>/ticket panel</code>.
      </p>

      <ul className="saved-list">
        {panels.map((panel, index) => {
          const open = openIndex === index;
          const missing = panel.typeIds.filter((typeId) => !known.has(typeId));

          return (
            <li
              className="saved-item"
              // biome-ignore lint/suspicious/noArrayIndexKey: the id is edited in place, so it cannot key its own row
              key={`panel-${index}`}
            >
              <div className="saved-head">
                <button
                  type="button"
                  className="saved-toggle"
                  aria-expanded={open}
                  onClick={() => setOpenIndex(open ? null : index)}
                >
                  <Icon name={open ? 'caret-up' : 'caret-down'} />
                  <span className="saved-name">{panel.name || 'Unnamed'}</span>
                  <span className="saved-summary">{summarise(panel, missing)}</span>
                </button>

                <button
                  type="button"
                  className="button button-ghost"
                  aria-label={`Remove the ${panel.name || 'unnamed'} panel`}
                  onClick={() => {
                    onChange(panels.filter((_, i) => i !== index));
                    setOpenIndex(null);
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>

              {open ? (
                <PanelDetail
                  panel={panel}
                  invalid={(field) => failed.has(`${index}.${field}`)}
                  missing={missing}
                  textChoices={textChoices}
                  typeChoices={typeChoices}
                  onChange={(patch) => update(index, patch)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>

      {panels.length === 0 ? (
        <p className="field-empty">
          No ticket panels. Members have no way to open a ticket until there is at least one.
        </p>
      ) : null}

      <button
        type="button"
        className="button button-quiet"
        disabled={panels.length >= ceiling}
        onClick={() => {
          onChange([
            ...panels,
            blankPanel(
              panels.length,
              typeChoices.slice(0, 1).map((choice) => choice.id),
            ),
          ]);
          setOpenIndex(panels.length);
        }}
      >
        {panels.length >= ceiling ? ceilingNote(tier, 'ticketPanels') : 'Add panel'}
      </button>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {describeIssuePath(issue.path)}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
