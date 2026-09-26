import { checkListLimit, LIMIT_LABELS } from '@proton/core';
import type { FormConfig } from '@proton/module-applications/config';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { EmojiGlyph } from '../../components/discord/emoji-picker.tsx';
import {
  CollectionHeader,
  CollectionStaticRow,
  MetaSeparator,
} from '../../components/ui/collection.tsx';
import { Badge, Button, SearchField } from '../../components/ui/controls.tsx';
import { EmptyState, Spinner, StatusBanner } from '../../components/ui/feedback.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { Dialog, MenuButton } from '../../components/ui/overlay.tsx';
import { readFailure } from '../../lib/errors.ts';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import { formsOverviewQuery } from './admin-queries.ts';
import { CreateFormDialog } from './create-dialog.tsx';
import {
  type ApplicationsForm,
  countLines,
  type DeleteCheck,
  deleteCheck,
  duplicateForm,
  type FormEntry,
  formBadges,
  formTitle,
  intakeDetail,
  joinAnd,
  panelsListing,
  questionCount,
  savedIds,
  takenFormIds,
  updateFormAt,
  withoutForm,
} from './shape.ts';

const SEARCH_FROM = 8;

const EMPTY =
  'Start from a template for staff, team, partner or event applications, or build your own.';

const HAS_SUBMISSIONS =
  'People have already applied on this form, so it can’t be deleted. Archive it instead: it ' +
  'stops taking applications, and everything already sent stays readable and exportable.';

const WAS_PUBLISHED =
  'This form has been published, so it can’t be deleted. Archive it instead: it stops taking ' +
  'applications, and its published versions stay on record under its ID.';

const UNCHECKED = 'Proton couldn’t check this form for submissions. Try again in a moment.';

export function FormsArea({
  form,
  guildId,
  onOpen,
}: {
  form: ApplicationsForm;
  guildId: string;
  onOpen: (formId: string) => void;
}): ReactElement {
  const config = form.value;
  const tier = form.view.tier;

  const queryClient = useQueryClient();
  const overview = useQuery(formsOverviewQuery(guildId));
  const entries = overview.data?.forms;

  const [term, setTerm] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<FormConfig | null>(null);

  const ceiling = listCeiling(tier, 'applicationForms');
  const full = config.forms.length >= ceiling;
  const overLimit = checkListLimit(tier, 'applicationForms', config.forms.length);

  const needle = term.trim().toLowerCase();
  const shown = config.forms.filter(
    (entry) =>
      needle === '' ||
      entry.name.toLowerCase().includes(needle) ||
      entry.id.toLowerCase().includes(needle),
  );

  const entryFor = (formId: string): FormEntry | undefined =>
    entries?.find((candidate) => candidate.id === formId);

  const create = (created: FormConfig): void => {
    form.setValue((current) => ({ ...current, forms: [...current.forms, created] }));
    setCreating(false);
    onOpen(created.id);
  };

  const taken = takenFormIds(config, overview.data);
  const savedForms = savedIds(form.view.config, 'forms');
  const recheck = (): void =>
    void queryClient.invalidateQueries({ queryKey: formsOverviewQuery(guildId).queryKey });

  const duplicate = (source: FormConfig): void => {
    const copy = duplicateForm(source, taken);
    form.setValue((current) => ({ ...current, forms: [...current.forms, copy] }));
    onOpen(copy.id);
  };

  const setArchived = (formId: string, archived: boolean): void => {
    const index = config.forms.findIndex((entry) => entry.id === formId);
    if (index !== -1) updateFormAt(form, index, (current) => ({ ...current, archived }));
  };

  return (
    <Section>
      <CollectionHeader
        title="Forms"
        used={config.forms.length}
        ceiling={ceiling}
        limitLabel={LIMIT_LABELS.applicationForms}
        actions={
          <>
            {config.forms.length > SEARCH_FROM || term !== '' ? (
              <SearchField
                value={term}
                onChange={setTerm}
                label="Search forms"
                placeholder="Search forms…"
              />
            ) : null}
            <Button
              tone="primary"
              icon="plus"
              disabled={full}
              title={full ? ceilingNote(tier, 'applicationForms') : undefined}
              onClick={() => setCreating(true)}
            >
              Create form
            </Button>
          </>
        }
      />

      {!overLimit.ok ? (
        <StatusBanner tone="warning" title="Too many forms">
          {overLimit.humanReason}
        </StatusBanner>
      ) : null}

      {overview.isError ? (
        <StatusBanner tone="danger" live="polite">
          {readFailure(overview.error, 'which forms are published')}
        </StatusBanner>
      ) : null}

      {config.forms.length === 0 ? (
        <EmptyState
          icon="identification-card"
          title="No forms yet"
          inset
          actions={
            <Button tone="primary" icon="plus" disabled={full} onClick={() => setCreating(true)}>
              Create form
            </Button>
          }
        >
          {EMPTY}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon="magnifying-glass" title="No matching forms" inset />
      ) : (
        <Rows>
          {shown.map((entry) => (
            <FormRow
              key={entry.id}
              entry={entry}
              saved={entryFor(entry.id)}
              known={entries !== undefined}
              full={full}
              onEdit={() => onOpen(entry.id)}
              onDuplicate={() => duplicate(entry)}
              onArchive={(archived) => setArchived(entry.id, archived)}
              onDelete={() => {
                setDeleting(entry);
                recheck();
              }}
            />
          ))}
        </Rows>
      )}

      <CreateFormDialog
        open={creating}
        taken={taken}
        retired={overview.data?.retiredFormIds}
        onClose={() => setCreating(false)}
        onCreate={create}
      />

      <DeleteFormDialog
        target={deleting}
        check={
          deleting === null
            ? 'allowed'
            : deleteCheck({
                entry: entryFor(deleting.id),
                saved: savedForms.has(deleting.id),
                fetching: overview.isFetching,
                failed: overview.isError,
              })
        }
        panels={deleting === null ? [] : panelsListing(config, deleting.id).map((p) => p.name)}
        onClose={() => setDeleting(null)}
        onRetry={recheck}
        onArchive={(target) => {
          setArchived(target.id, true);
          setDeleting(null);
        }}
        onConfirm={(target) => {
          form.setValue((current) => withoutForm(current, target.id));
          setDeleting(null);
        }}
      />
    </Section>
  );
}

function FormRow({
  entry,
  saved,
  known,
  full,
  onEdit,
  onDuplicate,
  onArchive,
  onDelete,
}: {
  entry: FormConfig;
  saved: FormEntry | undefined;
  known: boolean;
  full: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onArchive: (archived: boolean) => void;
  onDelete: () => void;
}): ReactElement {
  const questions = questionCount(entry.sections);
  const badges = formBadges(saved, entry);
  const detail = saved === undefined ? null : intakeDetail(saved.intake);
  const counts = countLines(saved);
  const issues = saved?.requirementIssues ?? [];

  return (
    <div>
      <CollectionStaticRow
        icon={entry.emoji === undefined ? 'identification-card' : undefined}
        glyph={entry.emoji === undefined ? undefined : <EmojiGlyph emoji={entry.emoji} size={17} />}
        title={formTitle(entry)}
        badge={
          <>
            {badges.map((badge) => (
              <Badge key={badge.label} tone={badge.tone}>
                {badge.label}
              </Badge>
            ))}
            {issues.length > 0 ? <Badge tone="warning">Requirement can’t be checked</Badge> : null}
          </>
        }
        meta={
          <>
            <span>
              {questions} {questions === 1 ? 'question' : 'questions'}
            </span>
            {detail !== null ? (
              <>
                <MetaSeparator />
                <span>{detail}</span>
              </>
            ) : null}
            {counts.map((line) => (
              <span key={line} className="applications-meta-part">
                <MetaSeparator />
                <span>{line}</span>
              </span>
            ))}
            {known && saved === undefined ? (
              <>
                <MetaSeparator />
                <span>Not saved yet</span>
              </>
            ) : null}
          </>
        }
        aside={
          <>
            <Button size="sm" onClick={onEdit}>
              Edit
            </Button>
            <MenuButton
              label={`More actions for ${formTitle(entry)}`}
              actions={[
                {
                  id: 'duplicate',
                  label: 'Duplicate',
                  icon: 'clipboard-text',
                  disabled: full,
                  onSelect: onDuplicate,
                },
                entry.archived
                  ? {
                      id: 'unarchive',
                      label: 'Unarchive',
                      icon: 'archive',
                      onSelect: () => onArchive(false),
                    }
                  : {
                      id: 'archive',
                      label: 'Archive',
                      icon: 'archive',
                      onSelect: () => onArchive(true),
                    },
                {
                  id: 'delete',
                  label: 'Delete…',
                  icon: 'trash',
                  danger: true,
                  onSelect: onDelete,
                },
              ]}
            />
          </>
        }
      />

      {issues.length > 0 ? (
        <p className="applications-row-note applications-row-warning">
          {issues.map((issue) => issue.humanReason).join(' ')} Members can’t apply until this is
          fixed.
        </p>
      ) : null}
    </div>
  );
}

function panelNote(panels: readonly string[]): string {
  return (
    `It’s also taken off ${panels.length === 1 ? 'the panel' : 'the panels'} ` +
    `${joinAnd(panels)}. Messages already posted keep their button until you post the panel again.`
  );
}

function DeleteFormDialog({
  target,
  check,
  panels,
  onClose,
  onRetry,
  onArchive,
  onConfirm,
}: {
  target: FormConfig | null;
  check: DeleteCheck;
  panels: readonly string[];
  onClose: () => void;
  onRetry: () => void;
  onArchive: (target: FormConfig) => void;
  onConfirm: (target: FormConfig) => void;
}): ReactElement {
  const name = target === null ? 'form' : formTitle(target);

  if (check === 'submissions' || check === 'published') {
    return (
      <Dialog
        open={target !== null}
        onClose={onClose}
        title={`${name} can’t be deleted`}
        size="compact"
        icon="archive"
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            {target !== null && !target.archived ? (
              <Button tone="primary" onClick={() => onArchive(target)}>
                Archive form
              </Button>
            ) : null}
          </>
        }
      >
        <p className="text-secondary text-sm">
          {target?.archived ? 'This form is already archived. ' : ''}
          {check === 'submissions' ? HAS_SUBMISSIONS : WAS_PUBLISHED}
        </p>
      </Dialog>
    );
  }

  const waiting = check === 'waiting';
  const unknown = check === 'unknown';

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={`Delete ${name}?`}
      size="compact"
      icon="trash"
      tone="danger"
      footerNote={
        waiting ? (
          <span className="inline inline-6">
            <Spinner size="sm" label="Checking for submissions" />
            Checking for submissions…
          </span>
        ) : undefined
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {unknown ? <Button onClick={onRetry}>Try again</Button> : null}
          <Button
            tone="danger"
            disabled={waiting || unknown}
            onClick={() => target !== null && onConfirm(target)}
          >
            Delete form
          </Button>
        </>
      }
    >
      <div className="stack stack-12">
        {unknown ? (
          <StatusBanner tone="warning" live="polite">
            {UNCHECKED}
          </StatusBanner>
        ) : (
          <p className="text-secondary text-sm">
            This form was never published, so no one has applied to it. It’s gone once you save.
          </p>
        )}
        {panels.length > 0 ? <p className="text-secondary text-sm">{panelNote(panels)}</p> : null}
      </div>
    </Dialog>
  );
}
