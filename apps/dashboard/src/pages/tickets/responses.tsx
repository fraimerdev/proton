import type { TemplateReport } from '@proton/core/placeholders';
import { RESPONSES_CEILING, type TicketResponse } from '@proton/module-tickets/config';
import { TICKET_RESPONSE_SURFACE } from '@proton/module-tickets/placeholders';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import type { DynamicPlaceholder } from '../../components/placeholders/autocomplete.ts';
import { PlaceholderSuggestions } from '../../components/placeholders/placeholder-suggestions.tsx';
import { TemplateDiagnostics } from '../../components/placeholders/template-diagnostics.tsx';
import { CollectionHeader } from '../../components/ui/collection.tsx';
import {
  Button,
  Chip,
  IconButton,
  SearchField,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import { EmptyState } from '../../components/ui/feedback.tsx';
import { DetailField, ExpandableRow, Rows, Section } from '../../components/ui/layout.tsx';
import {
  answerPlaceholders,
  duplicateIds,
  responseIds,
  responsePreview,
  setResponses,
  slugTyping,
  type TicketsForm,
  uniqueSlug,
  updateResponseAt,
  useTemplateField,
  useTicketTemplates,
} from './shape.ts';

const ID_MAX = 32;
const LABEL_MAX = 64;
const CONTENT_MAX = 2000;

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

const ID_SHAPE =
  'a quick response id is letters, digits, dots, dashes and underscores, starting with a letter or digit.';

const ID_CLASH =
  'two quick responses cannot share an id — a button would not know which one it meant.';

const NO_NAME = 'Quick response needs a name. Staff choose it by name in /ticket response.';

const NO_MESSAGE = 'Quick response needs a message.';

const EMPTY = 'Save replies staff can post in a ticket with /ticket response.';

const MENTIONS_NOTE =
  'Posted as a normal message. @everyone, @here and role mentions in it do not notify anyone, but ' +
  'a mention of the ticket’s owner does.';

const ID_NOTE = 'Staff can also type the ID in /ticket response. Changing it is safe.';

export function ResponsesArea({ form }: { form: TicketsForm }): ReactElement {
  const config = form.value;
  const [term, setTerm] = useState('');
  const report = useTicketTemplates(form);
  const answers = useMemo(() => answerPlaceholders(config.types), [config.types]);

  const full = config.responses.length >= RESPONSES_CEILING;
  const clashes = duplicateIds(config.responses);

  const needle = term.trim().toLowerCase();
  const shown = config.responses.filter(
    (response) =>
      needle === '' ||
      response.label.toLowerCase().includes(needle) ||
      response.id.toLowerCase().includes(needle) ||
      response.content.toLowerCase().includes(needle),
  );

  const add = (): void => {
    const id = uniqueSlug(`reply-${config.responses.length + 1}`, responseIds(config), ID_MAX);
    setResponses(form, [...config.responses, { id, label: '', content: '' }]);
    setTerm('');
  };

  const duplicate = (response: TicketResponse): void => {
    const id = uniqueSlug(`${response.id}-copy`, responseIds(config), ID_MAX);
    setResponses(form, [...config.responses, { ...response, id }]);
  };

  return (
    <Section>
      <CollectionHeader
        title="Quick responses"
        used={config.responses.length}
        ceiling={RESPONSES_CEILING}
        limitLabel="quick responses"
        actions={
          <>
            <SearchField
              value={term}
              onChange={setTerm}
              label="Search quick responses"
              placeholder="Search quick responses…"
            />
            <Button tone="primary" icon="plus" disabled={full} onClick={add}>
              Create quick response
            </Button>
          </>
        }
      />

      {config.responses.length === 0 ? (
        <EmptyState icon="chat-centered-text" title="No quick responses" inset>
          {EMPTY}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon="magnifying-glass" title="No matching quick responses" inset />
      ) : (
        <Rows>
          {shown.map((response) => {
            const index = config.responses.indexOf(response);

            return (
              <ExpandableRow
                // Keyed on position: keying on the editable id unmounts the input as it is typed.
                key={index}
                icon="chat-centered-text"
                title={response.label.trim() === '' ? 'Untitled quick response' : response.label}
                description={response.content.split('\n')[0] ?? ''}
                badge={<Chip className="mono">{response.id}</Chip>}
                defaultOpen={response.label === '' && response.content === ''}
                control={
                  <>
                    <IconButton
                      icon="clipboard-text"
                      tone="ghost"
                      size="sm"
                      label={`Duplicate ${response.label || response.id}`}
                      disabled={full}
                      onClick={() => duplicate(response)}
                    />
                    <IconButton
                      icon="trash"
                      tone="ghost"
                      size="sm"
                      label={`Delete ${response.label || response.id}`}
                      onClick={() =>
                        setResponses(
                          form,
                          config.responses.filter((_, at) => at !== index),
                        )
                      }
                    />
                  </>
                }
                detail={() => (
                  <ResponseDetail
                    form={form}
                    report={report}
                    answers={answers}
                    index={index}
                    response={response}
                    clash={clashes.has(index)}
                  />
                )}
              />
            );
          })}
        </Rows>
      )}
    </Section>
  );
}

function ResponseDetail({
  form,
  report,
  answers,
  index,
  response,
  clash,
}: {
  form: TicketsForm;
  report: TemplateReport;
  answers: readonly DynamicPlaceholder[];
  index: number;
  response: TicketResponse;
  clash: boolean;
}): ReactElement {
  const path = `responses.${index}`;

  const idError = clash
    ? ID_CLASH
    : !SLUG.test(response.id)
      ? ID_SHAPE
      : form.errorAt(`${path}.id`);

  const labelError = response.label.trim() === '' ? NO_NAME : form.errorAt(`${path}.label`);

  const message = useTemplateField({
    surface: TICKET_RESPONSE_SURFACE,
    report,
    path: `${path}.content`,
    onChange: (content) => updateResponseAt(form, index, { content }),
    error: response.content.trim() === '' ? NO_MESSAGE : form.errorAt(`${path}.content`),
    dynamic: answers,
  });

  const preview = responsePreview(form.value.types, index, response.content);

  return (
    <>
      <DetailField label="Name">
        <TextInput
          width="lg"
          aria-label="Name"
          maxLength={LABEL_MAX}
          invalid={labelError !== undefined}
          value={response.label}
          onChange={(event) => updateResponseAt(form, index, { label: event.currentTarget.value })}
        />
      </DetailField>
      {labelError !== undefined ? <p className="row-error">{labelError}</p> : null}

      <DetailField label="ID">
        <TextInput
          width="sm"
          className="mono"
          aria-label="ID"
          spellCheck={false}
          maxLength={ID_MAX}
          invalid={idError !== undefined}
          value={response.id}
          onChange={(event) =>
            updateResponseAt(form, index, { id: slugTyping(event.currentTarget.value, ID_MAX) })
          }
        />
      </DetailField>
      <p className={idError === undefined ? 'row-note tickets-detail-note' : 'row-error'}>
        {idError ?? ID_NOTE}
      </p>

      <DetailField label="Message">
        <div className="message-field wide">
          <TextArea
            {...message.autocomplete.field}
            aria-label="Message"
            aria-describedby={message.describedBy}
            rows={5}
            maxLength={CONTENT_MAX}
            invalid={message.invalid}
            value={response.content}
            onChange={(event) =>
              updateResponseAt(form, index, { content: event.currentTarget.value })
            }
          />
          <PlaceholderSuggestions autocomplete={message.autocomplete} />
          <TemplateDiagnostics id={message.diagnosticsId} diagnostics={message.diagnostics} />
        </div>
      </DetailField>
      <p className={message.error === undefined ? 'row-note tickets-detail-note' : 'row-error'}>
        {message.error ?? MENTIONS_NOTE}
      </p>

      {response.content.trim() === '' ? null : (
        <DetailField label="Preview">
          <div>
            <DiscordPreview
              message={{ content: preview.text }}
              mentionNames={preview.mentionNames}
              now={preview.now}
            />
            <p className="tickets-preview-note">{preview.caption}</p>
          </div>
        </DetailField>
      )}
    </>
  );
}
