import { type Counter, type CounterSource, TEMPLATE_MAX } from '@proton/module-counters/config';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { ChannelName } from '../../components/discord/channel-picker.tsx';
import { PlaceholderSuggestions } from '../../components/placeholders/placeholder-suggestions.tsx';
import { TemplateDiagnostics } from '../../components/placeholders/template-diagnostics.tsx';
import {
  CollectionButtonRow,
  CollectionHeader,
  MetaSeparator,
} from '../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  Field,
  SearchField,
  SegmentedControl,
  TextInput,
} from '../../components/ui/controls.tsx';
import { EmptyState, Spinner } from '../../components/ui/feedback.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { Dialog } from '../../components/ui/overlay.tsx';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import { channelsQuery } from '../../lib/queries.ts';
import {
  type CountersForm,
  counterIssues,
  hasCount,
  NamePreview,
  NEW_COUNTER_PATH,
  newCounterReport,
  nextCounterId,
  prefillFor,
  SOURCE_ICON,
  SOURCE_LABEL,
  SOURCE_OPTIONS,
  setCounters,
  TemplateName,
  useTemplateField,
} from './shape.tsx';

const SEARCH_FROM = 8;

const INTRO =
  'Counts refresh every 10 minutes, not instantly. Saving asks for a refresh straight away.';

export function CounterList({
  form,
  guildId,
  broken,
  query,
  onQuery,
  onOpen,
}: {
  form: CountersForm;
  guildId: string;
  broken: ReadonlySet<number>;
  query: string;
  onQuery: (query: string) => void;
  onOpen: (counterId: string) => void;
}): ReactElement {
  const [adding, setAdding] = useState(false);

  const counters = form.value.counters;
  const searchable = counters.length > SEARCH_FROM;

  const pointed = counters.some((counter) => counter.channelId !== undefined);
  const { data: channels, isPending: channelsPending } = useQuery({
    ...channelsQuery(guildId),
    enabled: pointed,
  });
  const channelById = new Map((channels ?? []).map((channel) => [channel.id, channel]));

  const ceiling = listCeiling(form.view.tier, 'counters');
  const atCeiling = counters.length >= ceiling;

  const needle = searchable ? query.trim().toLowerCase() : '';

  const shown = counters
    .map((counter, index) => ({ counter, index }))
    .filter(
      ({ counter }) =>
        needle === '' ||
        counter.template.toLowerCase().includes(needle) ||
        counter.id.toLowerCase().includes(needle) ||
        SOURCE_LABEL[counter.source].toLowerCase().includes(needle) ||
        (counter.channelId !== undefined &&
          (channelById.get(counter.channelId)?.name.toLowerCase().includes(needle) ?? false)),
    );

  return (
    <Section intro={INTRO}>
      <CollectionHeader
        title="Counter channels"
        used={counters.length}
        ceiling={ceiling}
        limitLabel="counter channels"
        actions={
          <>
            {searchable ? (
              <SearchField
                value={query}
                onChange={onQuery}
                label="Search counters"
                placeholder="Search counters…"
              />
            ) : null}
            <Button
              tone="primary"
              icon="plus"
              disabled={atCeiling}
              title={atCeiling ? ceilingNote(form.view.tier, 'counters') : undefined}
              onClick={() => setAdding(true)}
            >
              Add counter
            </Button>
          </>
        }
      />

      {counters.length === 0 ? (
        <EmptyState
          icon="hash"
          title="No counter channels"
          inset
          actions={
            <Button tone="primary" icon="plus" onClick={() => setAdding(true)}>
              Add counter
            </Button>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState icon="magnifying-glass" title="No matching counters" inset>
          Search looks at name templates, IDs, what each counter counts and channel names.
        </EmptyState>
      ) : (
        <Rows>
          {shown.map(({ counter, index }) => (
            <CollectionButtonRow
              key={counter.id}
              icon={SOURCE_ICON[counter.source]}
              onSelect={() => onOpen(counter.id)}
              title={
                counter.template === '' ? (
                  <span className="text-muted">No name template</span>
                ) : (
                  <TemplateName template={counter.template} />
                )
              }
              badge={broken.has(index) ? <Badge tone="danger">Needs fixing</Badge> : null}
              meta={
                <>
                  {SOURCE_LABEL[counter.source]}
                  <MetaSeparator />
                  {counter.channelId !== undefined ? (
                    channelsPending ? (
                      <Spinner label="Loading channel" />
                    ) : (
                      <ChannelName
                        channel={channelById.get(counter.channelId)}
                        id={counter.channelId}
                      />
                    )
                  ) : (
                    'Channel created by Proton'
                  )}
                </>
              }
              aside={<span className="mono text-muted">{counter.id}</span>}
            />
          ))}
        </Rows>
      )}

      {adding ? (
        <AddCounterDialog
          counters={counters}
          onClose={() => setAdding(false)}
          onAdd={(counter) => {
            setCounters(form, [...counters, counter]);
            setAdding(false);
            onOpen(counter.id);
          }}
        />
      ) : null}
    </Section>
  );
}

function describedBy(...ids: readonly (string | undefined)[]): string | undefined {
  const joined = ids.filter((id) => id !== undefined).join(' ');
  return joined === '' ? undefined : joined;
}

function AddCounterDialog({
  counters,
  onClose,
  onAdd,
}: {
  counters: readonly Counter[];
  onClose: () => void;
  onAdd: (counter: Counter) => void;
}): ReactElement {
  const [source, setSource] = useState<CounterSource>('members');
  const [template, setTemplate] = useState(prefillFor('members'));
  const [edited, setEdited] = useState(false);

  const id = nextCounterId(counters, source);
  const trimmed = template.trim();

  const problem =
    trimmed === '' ? undefined : counterIssues({ id, template: trimmed, source }).get('template');

  const report = useMemo(
    () => newCounterReport({ id, template: trimmed, source }),
    [id, trimmed, source],
  );

  const name = useTemplateField({
    report,
    path: NEW_COUNTER_PATH,
    onChange: (next) => {
      setEdited(true);
      setTemplate(next);
    },
    error: problem,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add counter"
      description="Proton creates a channel for it. You can choose an existing channel later."
      footerNote={
        <>
          Counter ID <span className="mono">{id}</span>
        </>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            disabled={trimmed === '' || !hasCount(trimmed) || report.blocking.length > 0}
            onClick={() => onAdd({ id, template: trimmed, source })}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="stack stack-16">
        <div className="field">
          <span className="field-label">What to count</span>
          <SegmentedControl
            label="What to count"
            options={SOURCE_OPTIONS}
            value={source}
            block
            onChange={(next) => {
              setSource(next);
              if (!edited) setTemplate(prefillFor(next));
            }}
          />
        </div>

        <Field label="Name template" error={name.error}>
          {(props) => (
            <>
              <TextInput
                {...name.autocomplete.field}
                {...props}
                aria-describedby={describedBy(props['aria-describedby'], name.describedBy)}
                autoFocus
                spellCheck={false}
                maxLength={TEMPLATE_MAX}
                invalid={name.invalid}
                value={template}
                onChange={(event) => {
                  setEdited(true);
                  setTemplate(event.currentTarget.value);
                }}
              />
              <PlaceholderSuggestions autocomplete={name.autocomplete} />
              <TemplateDiagnostics id={name.diagnosticsId} diagnostics={name.diagnostics} />
            </>
          )}
        </Field>

        <div className="field">
          <span className="field-label">Channel name</span>
          <NamePreview template={template} source={source} icon="speaker-high" />
        </div>
      </div>
    </Dialog>
  );
}
