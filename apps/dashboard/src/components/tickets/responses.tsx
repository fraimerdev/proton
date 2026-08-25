import {
  RESPONSES_CEILING,
  type TicketResponse,
  ticketResponsesSchema,
} from '@proton/module-tickets/config';
import type { ReactElement } from 'react';

export interface TicketResponsesEditorProps {
  responses: readonly TicketResponse[];
  onChange: (responses: TicketResponse[]) => void;
}

function blank(index: number): TicketResponse {
  return { id: `reply-${index + 1}`, label: 'Saved reply', content: '' };
}

export function TicketResponsesEditor({
  responses,
  onChange,
}: TicketResponsesEditorProps): ReactElement {
  const parsed = ticketResponsesSchema.safeParse(responses);

  function update(index: number, patch: Partial<TicketResponse>): void {
    onChange(responses.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  return (
    <div className="ladder" data-path="responses">
      <p className="field-description">
        Answers your team sends often. Staff post one into a ticket with{' '}
        <code>/ticket response</code>, choosing it by name.
      </p>

      {responses.map((response, index) => (
        <div
          className="ladder-rung ladder-rung-stacked"
          // biome-ignore lint/suspicious/noArrayIndexKey: the edited value cannot key its own row
          key={`response-${index}`}
        >
          <label className="filter">
            <span>Name</span>
            <input
              type="text"
              value={response.id}
              aria-invalid={response.id === ''}
              onChange={(e) => update(index, { id: e.target.value })}
            />
          </label>

          <label className="filter">
            <span>Shown as</span>
            <input
              type="text"
              value={response.label}
              onChange={(e) => update(index, { label: e.target.value })}
            />
          </label>

          <label className="filter">
            <span>Message</span>
            <textarea
              rows={3}
              value={response.content}
              aria-invalid={response.content === ''}
              onChange={(e) => update(index, { content: e.target.value })}
            />
          </label>

          <button
            type="button"
            className="button button-ghost"
            aria-label={`Remove the ${response.label} reply`}
            onClick={() => onChange(responses.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}

      {responses.length === 0 ? (
        <p className="field-empty">
          No saved replies yet. Staff answer every ticket from scratch until there is one.
        </p>
      ) : null}

      <button
        type="button"
        className="button button-quiet"
        onClick={() => onChange([...responses, blank(responses.length)])}
        disabled={responses.length >= RESPONSES_CEILING}
      >
        {responses.length >= RESPONSES_CEILING
          ? `${RESPONSES_CEILING} saved replies is the most Proton keeps`
          : 'Add a saved reply'}
      </button>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {issue.path.length > 0 ? `Reply ${Number(issue.path[0]) + 1}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
