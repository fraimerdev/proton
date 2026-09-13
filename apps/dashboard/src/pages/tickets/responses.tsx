import { RESPONSES_CEILING, type TicketResponse } from '@proton/module-tickets/config';
import type { ReactElement } from 'react';
import { useState } from 'react';
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
  duplicateIds,
  responseIds,
  setResponses,
  slugify,
  type TicketsForm,
  uniqueSlug,
  updateResponseAt,
} from './shape.ts';

const ID_MAX = 32;
const LABEL_MAX = 64;
const CONTENT_MAX = 2000;

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

const ID_SHAPE =
  'a quick response id is letters, digits, dots, dashes and underscores, starting with a letter or digit.';

const EMPTY = 'Save replies staff can post in a ticket with /ticket response.';

const MENTIONS_NOTE =
  'Posted as a normal message. @everyone, @here and role mentions in it do not notify anyone, but ' +
  'a mention of the ticket’s owner does.';

const ID_NOTE = 'Staff can also type the ID in /ticket response. Changing it is safe.';

export function ResponsesArea({ form }: { form: TicketsForm }): ReactElement {
  const config = form.value;
  const [term, setTerm] = useState('');

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
            const path = `responses.${index}`;

            const idError = clashes.has(index)
              ? 'two quick responses cannot share an id — a button would not know which one it meant.'
              : !SLUG.test(response.id)
                ? ID_SHAPE
                : form.errorAt(`${path}.id`);

            const labelError =
              response.label.trim() === ''
                ? 'Quick response needs a name. Staff choose it by name in /ticket response.'
                : form.errorAt(`${path}.label`);

            const contentError =
              response.content.trim() === ''
                ? 'Quick response needs a message.'
                : form.errorAt(`${path}.content`);

            return (
              <ExpandableRow
                // Keyed on position, not on the id: the id field is editable, and rekeying on every
                // keystroke would unmount the input being typed into.
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
                  <>
                    <DetailField label="Name">
                      <TextInput
                        width="lg"
                        aria-label="Name"
                        maxLength={LABEL_MAX}
                        invalid={labelError !== undefined}
                        value={response.label}
                        onChange={(event) =>
                          updateResponseAt(form, index, { label: event.currentTarget.value })
                        }
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
                          updateResponseAt(form, index, {
                            id: slugify(event.currentTarget.value, ID_MAX),
                          })
                        }
                      />
                    </DetailField>
                    <p
                      className={
                        idError === undefined ? 'row-note tickets-detail-note' : 'row-error'
                      }
                    >
                      {idError ?? ID_NOTE}
                    </p>

                    <DetailField label="Message">
                      <TextArea
                        aria-label="Message"
                        rows={5}
                        maxLength={CONTENT_MAX}
                        invalid={contentError !== undefined}
                        value={response.content}
                        onChange={(event) =>
                          updateResponseAt(form, index, { content: event.currentTarget.value })
                        }
                      />
                    </DetailField>
                    <p
                      className={
                        contentError === undefined ? 'row-note tickets-detail-note' : 'row-error'
                      }
                    >
                      {contentError ?? MENTIONS_NOTE}
                    </p>
                  </>
                )}
              />
            );
          })}
        </Rows>
      )}
    </Section>
  );
}
