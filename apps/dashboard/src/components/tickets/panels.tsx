import { type TicketPanel, ticketPanelsSchema } from '@proton/module-tickets/config';
import { type ReactElement, useId } from 'react';
import {
  channelOptions,
  type DiscordChannel,
  type DiscordRole,
  roleOptions,
  SinglePicker,
  TokenPicker,
} from '../form/picker.tsx';

export interface TicketPanelsEditorProps {
  panels: readonly TicketPanel[];
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  onChange: (panels: TicketPanel[]) => void;
}

const MAX_PANELS = 40;

const TEXT_CHANNEL_TYPE = 0;
const CATEGORY_CHANNEL_TYPE = 4;

function blank(index: number): TicketPanel {
  return {
    id: `panel-${index + 1}`,
    name: 'Support',
    channelId: '',
    buttonLabel: 'Open a ticket',
    panelText: 'Need a hand? Open a ticket and the team will be with you.',
    openingMessage: '{user} opened a ticket. Describe the problem and someone will help.',
    supportRoleIds: [],
  };
}

export function TicketPanelsEditor({
  panels,
  channels,
  roles,
  onChange,
}: TicketPanelsEditorProps): ReactElement {
  const fieldId = useId();
  const parsed = ticketPanelsSchema.safeParse(panels);

  const textChoices = channelOptions(channels, [TEXT_CHANNEL_TYPE]);
  const categoryChoices = channelOptions(channels, [CATEGORY_CHANNEL_TYPE]);
  const roleChoices = roleOptions(roles);

  function update(index: number, patch: Partial<TicketPanel>): void {
    onChange(panels.map((panel, i) => (i === index ? { ...panel, ...patch } : panel)));
  }

  return (
    <div className="ladder" data-path="panels">
      <p className="field-description">
        Each panel is a message with a button. Pressing it opens a private channel that only the
        member and the support roles below can read. Post a panel into Discord with{' '}
        <code>/ticket panel</code>.
      </p>

      {panels.map((panel, index) => {
        // A label wrapping the picker would forward option clicks back to the trigger and reopen it.
        const channelControlId = `${fieldId}-channel-${index}`;
        const categoryControlId = `${fieldId}-category-${index}`;
        const transcriptControlId = `${fieldId}-transcript-${index}`;

        return (
          <div
            className="ladder-rung ladder-rung-stacked"
            // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own row
            key={`panel-${index}`}
          >
            <label className="filter">
              <span>Id</span>
              <input
                type="text"
                value={panel.id}
                aria-invalid={panel.id === ''}
                onChange={(e) => update(index, { id: e.target.value })}
              />
            </label>

            <label className="filter">
              <span>Name</span>
              <input
                type="text"
                value={panel.name}
                onChange={(e) => update(index, { name: e.target.value })}
              />
            </label>

            <div className="filter">
              <span>
                <label htmlFor={channelControlId}>Panel lives in</label>
              </span>
              <SinglePicker
                id={channelControlId}
                label="Panel lives in"
                options={textChoices}
                value={panel.channelId === '' ? null : panel.channelId}
                onChange={(next) => update(index, { channelId: next ?? '' })}
                emptyLabel="Choose a channel…"
                clearable={false}
                invalid={panel.channelId === ''}
              />
            </div>

            <div className="filter">
              <span>
                <label htmlFor={categoryControlId}>Tickets open in</label>
              </span>
              <SinglePicker
                id={categoryControlId}
                label="Tickets open in"
                options={categoryChoices}
                value={panel.categoryId ?? null}
                onChange={(next) => update(index, next === null ? {} : { categoryId: next })}
                emptyLabel="No category"
                clearable
              />
            </div>

            <label className="filter">
              <span>Button says</span>
              <input
                type="text"
                value={panel.buttonLabel}
                onChange={(e) => update(index, { buttonLabel: e.target.value })}
              />
            </label>

            <label className="filter">
              <span>Panel text</span>
              <textarea
                rows={2}
                value={panel.panelText}
                onChange={(e) => update(index, { panelText: e.target.value })}
              />
            </label>

            <label className="filter">
              <span>First message in the ticket</span>
              <textarea
                rows={2}
                value={panel.openingMessage}
                onChange={(e) => update(index, { openingMessage: e.target.value })}
              />
            </label>

            <div className="filter">
              <span>
                <label htmlFor={transcriptControlId}>Closed tickets are recorded in</label>
              </span>
              <SinglePicker
                id={transcriptControlId}
                label="Closed tickets are recorded in"
                options={textChoices}
                value={panel.transcriptChannelId ?? null}
                onChange={(next) =>
                  update(index, next === null ? {} : { transcriptChannelId: next })
                }
                emptyLabel="Nowhere"
                clearable
              />
            </div>

            <label className="filter">
              <span>Close after no reply for</span>
              <input
                type="text"
                placeholder="e.g. 48h — leave empty to never close automatically"
                value={panel.autoCloseAfter ?? ''}
                onChange={(e) =>
                  update(index, e.target.value === '' ? {} : { autoCloseAfter: e.target.value })
                }
              />
            </label>

            <div className="filter">
              <span>Support roles</span>
              <TokenPicker
                label="Support roles"
                options={roleChoices}
                values={panel.supportRoleIds}
                onChange={(next) => update(index, { supportRoleIds: next })}
              />
            </div>

            <button
              type="button"
              className="button button-quiet"
              aria-label={`Remove the ${panel.name} panel`}
              onClick={() => onChange(panels.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </div>
        );
      })}

      {panels.length === 0 ? (
        <p className="field-empty">
          No ticket panels. Members have no way to open a ticket until there is at least one.
        </p>
      ) : null}

      <button
        type="button"
        className="button button-quiet"
        onClick={() => onChange([...panels, blank(panels.length)])}
        disabled={panels.length >= MAX_PANELS}
      >
        {panels.length >= MAX_PANELS ? `Limit of ${MAX_PANELS} panels reached` : 'Add panel'}
      </button>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {issue.path.length > 0 ? `Panel ${Number(issue.path[0]) + 1}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
