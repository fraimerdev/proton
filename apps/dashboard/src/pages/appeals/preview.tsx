import type { ContainerChild, V2Component } from '@proton/core';
import type { AppealPanel } from '@proton/module-appeals/config';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { Button, TextArea } from '../../components/ui/controls.tsx';
import { SegmentedTabs } from '../../components/ui/tabs.tsx';
import { panelTitle } from './shape.ts';

// Duplicated from appeals/src/review.ts, which has no browser-safe subpath. If the module's accent
// colours change, these change with them or the preview lies about the card Discord receives.
const APPEAL_OPEN = 0xf0b752;
const APPEAL_APPROVED = 0x4fcf95;
const APPEAL_DENIED = 0xff7a86;

const ANSWER_MAX_SHOWN = 900;

const SAMPLE_NUMBER = 1;
const SAMPLE_USER = '<@000000000000000000>';

type CardStatus = 'open' | 'approved' | 'denied';

function quoted(value: string): string {
  const cut = value.length > ANSWER_MAX_SHOWN ? `${value.slice(0, ANSWER_MAX_SHOWN)}…` : value;

  return ['```', cut.replaceAll('`', "'"), '```'].join('\n');
}

function reviewCard(panel: AppealPanel, status: CardStatus): V2Component {
  const verdict =
    status === 'approved' ? ' — accepted' : status === 'denied' ? ' — turned down' : '';

  const children: ContainerChild[] = [
    {
      kind: 'text',
      content: `## Appeal #${SAMPLE_NUMBER}${verdict}\n**${panelTitle(panel)}** · ${SAMPLE_USER}`,
    },
  ];

  for (const question of panel.questions) {
    children.push({
      kind: 'text',
      content: `**${question.label}**\n${quoted(question.placeholder ?? question.label)}`,
    });
  }

  children.push({ kind: 'separator', divider: true, spacing: 'small' });

  if (status === 'open') {
    children.push({
      kind: 'row',
      row: {
        kind: 'buttons',
        buttons: [
          { key: 'approve', style: 'success', label: 'Accept' },
          { key: 'deny', style: 'danger', label: 'Turn down' },
        ],
      },
    });
  } else {
    children.push({
      kind: 'text',
      content: `${status === 'approved' ? 'Accepted' : 'Turned down'} by ${SAMPLE_USER}.`,
    });
  }

  return {
    kind: 'container',
    accentColor:
      status === 'approved' ? APPEAL_APPROVED : status === 'denied' ? APPEAL_DENIED : APPEAL_OPEN,
    children,
  };
}

function AppellantForm({ panel }: { panel: AppealPanel }): ReactElement {
  return (
    <div className="panel stack stack-16">
      <div className="stack stack-6">
        <h3 className="section-title">{panelTitle(panel)}</h3>
        {panel.blurb.trim() !== '' ? <p className="text-secondary text-sm">{panel.blurb}</p> : null}
      </div>

      {panel.questions.map((question) => (
        <div className="field" key={question.key}>
          <span className="field-label">
            {question.label}
            {question.required ? null : <span className="text-muted"> (optional)</span>}
          </span>
          <TextArea
            readOnly
            rows={3}
            value=""
            maxLength={question.maxLength}
            placeholder={question.placeholder ?? ''}
            aria-label={question.label}
          />
          <span className="field-hint" style={{ textAlign: 'right' }}>
            0 / {question.maxLength}
          </span>
        </div>
      ))}

      <Button tone="primary" size="lg" disabled>
        Send appeal
      </Button>
    </div>
  );
}

export function PanelPreview({
  panel,
  channelName,
}: {
  panel: AppealPanel;
  channelName?: string | undefined;
}): ReactElement {
  const [tab, setTab] = useState<'card' | 'form'>('card');
  const [status, setStatus] = useState<CardStatus>('open');

  return (
    <div className="editor-preview stack stack-10">
      <SegmentedTabs
        label="Preview"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'card', label: 'Review card' },
          { id: 'form', label: 'Appeal page' },
        ]}
      />

      {tab === 'card' ? (
        <>
          <SegmentedTabs
            label="Appeal status"
            value={status}
            onChange={setStatus}
            items={[
              { id: 'open', label: 'Open' },
              { id: 'approved', label: 'Accepted' },
              { id: 'denied', label: 'Turned down' },
            ]}
          />
          <DiscordPreview message={{ v2: [reviewCard(panel, status)] }} channelName={channelName} />
          <p className="text-muted text-xs">
            Each answer shows its question’s placeholder. Real answers appear in the same code
            block, with backticks replaced and anything past {ANSWER_MAX_SHOWN} characters cut off.
          </p>
        </>
      ) : (
        <>
          <AppellantForm panel={panel} />
          <p className="text-muted text-xs">
            Members open this page from the link Proton sends them. It is never posted in a channel.
          </p>
        </>
      )}
    </div>
  );
}

export function DecisionDm({
  panel,
  status,
}: {
  panel: AppealPanel;
  status: 'approved' | 'denied';
}): ReactElement {
  const verdict = status === 'approved' ? panel.approvedMessage : panel.deniedMessage;
  const rejoin = status === 'approved' && panel.rejoinUrl ? `\n\n${panel.rejoinUrl}` : '';

  return (
    <DiscordPreview message={{ content: `**Appeal #${SAMPLE_NUMBER}**\n${verdict}${rejoin}` }} />
  );
}
