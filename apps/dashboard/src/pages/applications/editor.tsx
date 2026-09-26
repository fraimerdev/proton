import type { PublishResult } from '@proton/module-applications/view';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import { Badge, Button } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { SegmentedTabs } from '../../components/ui/tabs.tsx';
import { ActionsTab } from './actions.tsx';
import { formsOverviewQuery } from './admin-queries.ts';
import { IntakeTab } from './intake.tsx';
import { MessagesTab } from './messages.tsx';
import { PublishDialog } from './publish-dialog.tsx';
import { QuestionsTab } from './questions.tsx';
import { RequirementsTab } from './requirements.tsx';
import { ReviewTab } from './review-settings.tsx';
import {
  type ApplicationsForm,
  EDITOR_TAB_LABELS,
  EDITOR_TABS,
  type EditorTab,
  formBadges,
  savedIds,
} from './shape.ts';

const DIRTY = 'Save your changes first. Publishing uses the last saved version.';
const UNSAVED = 'Save this form first. Publishing uses the last saved version.';

const VERSIONED: readonly EditorTab[] = ['questions', 'requirements'];

const VERSIONED_NOTE =
  'Applicants see changes here once you publish. Anyone partway through keeps the version they ' +
  'started.';
const LIVE_NOTE = 'Changes here apply as soon as you save.';

const TABS = EDITOR_TABS.map((id) => ({ id, label: EDITOR_TAB_LABELS[id] }));

interface PublishNotice {
  result: PublishResult;
  policy: 'keep' | 'restart';
}

function noticeText({ result, policy }: PublishNotice, open: boolean): string {
  if (result.status === 'unchanged') {
    return `Nothing changed since version ${result.version}, so no new version was made.`;
  }

  const drafts =
    result.draftsExpired > 0
      ? ` ${result.draftsExpired} ${result.draftsExpired === 1 ? 'draft was' : 'drafts were'} cleared, and those applicants start again.`
      : policy === 'keep'
        ? ' Drafts already started finish on the version they began.'
        : '';
  const closed = open
    ? ''
    : ' The form isn’t taking applications yet. Turn on Accepting applications under Intake.';

  return `Published version ${result.version}.${drafts}${closed}`;
}

export function FormEditor({
  form,
  guildId,
  moduleId,
  index,
  tab,
  onTab,
}: {
  form: ApplicationsForm;
  guildId: string;
  moduleId: string;
  index: number;
  tab: EditorTab;
  onTab: (tab: EditorTab) => void;
}): ReactElement | null {
  const noteId = useId();
  const overview = useQuery(formsOverviewQuery(guildId));
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<PublishNotice | null>(null);

  const current = form.value.forms[index];
  if (current === undefined) return null;

  const entry = overview.data?.forms.find((candidate) => candidate.id === current.id);
  const saved = savedIds(form.view.config, 'forms').has(current.id);
  const blocker = form.dirty ? DIRTY : saved ? undefined : UNSAVED;
  const badges = formBadges(entry, current);

  return (
    <div className="applications-editor">
      <div className="applications-editor-head">
        <div className="applications-editor-status">
          {badges.map((badge) => (
            <Badge key={badge.label} tone={badge.tone}>
              {badge.label}
            </Badge>
          ))}
          <span className="text-xs text-muted mono">{current.id}</span>
        </div>
        <Button
          tone="primary"
          disabled={blocker !== undefined}
          aria-describedby={blocker === undefined ? undefined : noteId}
          onClick={() => setPublishing(true)}
        >
          Publish…
        </Button>
      </div>

      {blocker !== undefined ? (
        <p id={noteId} className="applications-editor-note">
          {blocker}
        </p>
      ) : null}

      {notice !== null ? (
        <div className="applications-editor-banner">
          <StatusBanner
            tone={notice.result.status === 'published' ? 'success' : 'info'}
            live="polite"
            onDismiss={() => setNotice(null)}
          >
            {noticeText(notice, current.intake.open)}
          </StatusBanner>
        </div>
      ) : null}

      <SegmentedTabs
        items={TABS}
        value={tab}
        onChange={onTab}
        label="Form settings"
        className="applications-editor-tabs"
      />

      <p className="applications-tab-note">
        {VERSIONED.includes(tab) ? VERSIONED_NOTE : LIVE_NOTE}
      </p>

      {tab === 'questions' ? (
        <QuestionsTab form={form} guildId={guildId} index={index} current={current} />
      ) : null}
      {tab === 'requirements' ? (
        <RequirementsTab
          form={form}
          guildId={guildId}
          index={index}
          current={current}
          saved={saved}
        />
      ) : null}
      {tab === 'review' ? (
        <ReviewTab
          form={form}
          guildId={guildId}
          moduleId={moduleId}
          index={index}
          current={current}
          saved={saved}
        />
      ) : null}
      {tab === 'messages' ? (
        <MessagesTab form={form} guildId={guildId} index={index} current={current} />
      ) : null}
      {tab === 'actions' ? (
        <ActionsTab form={form} guildId={guildId} index={index} current={current} />
      ) : null}
      {tab === 'intake' ? (
        <IntakeTab form={form} index={index} current={current} entry={entry} />
      ) : null}

      <PublishDialog
        open={publishing}
        guildId={guildId}
        current={current}
        entry={entry}
        overviewPending={overview.isPending}
        overviewFailed={overview.isError}
        onClose={() => setPublishing(false)}
        onPublished={(result, policy) => {
          setPublishing(false);
          setNotice({ result, policy });
        }}
      />
    </div>
  );
}
