import { classifyRegex } from '@proton/module-automod/regex-compat';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { CHANNEL_TYPE, ChannelMultiPicker } from '../../components/discord/channel-picker.tsx';
import { LimitCounter, useRecent } from '../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  Chip,
  cx,
  IconButton,
  SearchField,
  TextInput,
} from '../../components/ui/controls.tsx';
import { Icon } from '../../components/ui/icon.tsx';

export interface TokenIssue {
  token: string;
  text: string;
}

export const EXEMPT_CHANNEL_TYPES = [
  CHANNEL_TYPE.text,
  CHANNEL_TYPE.voice,
  CHANNEL_TYPE.announcement,
  CHANNEL_TYPE.announcementThread,
  CHANNEL_TYPE.publicThread,
  CHANNEL_TYPE.privateThread,
  CHANNEL_TYPE.stage,
  CHANNEL_TYPE.forum,
  CHANNEL_TYPE.media,
] as const;

function Issues({ issues }: { issues: readonly TokenIssue[] }): ReactElement | null {
  if (issues.length === 0) return null;

  return (
    <ul className="automod-issues">
      {issues.map((issue) => (
        <li key={issue.token}>
          <Icon name="warning" size={13} weight="fill" />
          <span>
            <span className="automod-issue-token mono">{issue.token}</span> {issue.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TokenField({
  label,
  value,
  onChange,
  max,
  maxLength,
  placeholder,
  issues = [],
  normalise = (raw) => raw.trim(),
  searchFrom,
  countLabel,
  mono = false,
}: {
  label: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  max: number;
  maxLength: number;
  placeholder: string;
  issues?: readonly TokenIssue[] | undefined;
  normalise?: ((raw: string) => string) | undefined;
  searchFrom?: number | undefined;
  countLabel: string;
  mono?: boolean | undefined;
}): ReactElement {
  const [entry, setEntry] = useState('');
  const [query, setQuery] = useState('');
  const recent = useRecent();

  const atMax = value.length >= max;
  const flagged = useMemo(() => new Set(issues.map((issue) => issue.token)), [issues]);

  const searching = searchFrom !== undefined && value.length >= searchFrom;
  const needle = query.trim().toLowerCase();
  const shown =
    searching && needle !== ''
      ? value.filter((token) => token.toLowerCase().includes(needle))
      : value;

  const add = (raw: string): void => {
    const next = [...value];

    for (const part of raw.split(/[\n,]/).map(normalise)) {
      if (part === '' || next.length >= max) continue;
      if (next.some((held) => held.toLowerCase() === part.toLowerCase())) continue;
      next.push(part.slice(0, maxLength));
    }

    setEntry('');
    if (next.length !== value.length) {
      recent.mark(...next.slice(value.length));
      onChange(next);
    }
  };

  return (
    <div className="stack stack-10">
      {searching ? (
        <SearchField
          value={query}
          onChange={setQuery}
          label={`Search ${label.toLowerCase()}`}
          placeholder={`Search ${label.toLowerCase()}…`}
        />
      ) : null}

      {shown.length > 0 ? (
        <div className="chip-list">
          {shown.map((token) => (
            <Chip
              key={token}
              className={cx(mono && 'mono', recent.enter(token, 'part'))}
              removeLabel={`Remove ${token}`}
              onRemove={() => onChange(value.filter((held) => held !== token))}
            >
              {flagged.has(token) ? (
                <Icon name="warning" size={11} weight="fill" className="text-warning" />
              ) : null}
              {token}
            </Chip>
          ))}
        </div>
      ) : null}

      <div className="automod-add">
        <TextInput
          value={entry}
          maxLength={maxLength}
          spellCheck={false}
          disabled={atMax}
          aria-label={`Add to ${label.toLowerCase()}`}
          placeholder={atMax ? 'Limit reached' : placeholder}
          onChange={(event) => setEntry(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add(entry);
          }}
        />
        <Button
          size="sm"
          icon="plus"
          disabled={atMax || entry.trim() === ''}
          onClick={() => add(entry)}
        >
          Add
        </Button>
        <LimitCounter used={value.length} ceiling={max} label={countLabel} />
      </div>

      <Issues issues={issues} />
    </div>
  );
}

/**
 * Patterns get one input each rather than a textarea: every one carries its own verdict on whether
 * Discord's engine will also run it, and a refusal names the pattern it refused.
 */
export function PatternField({
  value,
  onChange,
  max,
  issueAt,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  max: number;
  issueAt: (index: number) => string | undefined;
}): ReactElement {
  const recent = useRecent();

  const replace = (index: number, pattern: string): void =>
    onChange(value.map((held, at) => (at === index ? pattern : held)));

  return (
    <div className="stack stack-12">
      {value.map((pattern, index) => {
        const verdict = classifyRegex(pattern);
        const issue = issueAt(index);

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: patterns have no id and two may be equal
          <div className={cx('stack stack-6', recent.enter(index))} key={index}>
            <div className="automod-pattern">
              <TextInput
                className="mono"
                value={pattern}
                maxLength={260}
                spellCheck={false}
                invalid={issue !== undefined}
                aria-label={`Regex pattern ${index + 1}`}
                onChange={(event) => replace(index, event.currentTarget.value)}
              />
              <Badge tone={verdict.native ? 'info' : 'neutral'}>
                {verdict.native ? 'Discord' : 'Proton'}
              </Badge>
              <IconButton
                icon="trash"
                tone="ghost"
                size="sm"
                label={`Remove pattern ${index + 1}`}
                onClick={() => onChange(value.filter((_, at) => at !== index))}
              />
            </div>

            {!verdict.native ? (
              <p className="automod-note">Proton only — {verdict.reason}</p>
            ) : null}
            {issue !== undefined ? <p className="text-sm text-danger">{issue}</p> : null}
          </div>
        );
      })}

      <div className="automod-add">
        <Button
          size="sm"
          icon="plus"
          disabled={value.length >= max}
          onClick={() => {
            recent.mark(value.length);
            onChange([...value, '']);
          }}
        >
          Add pattern
        </Button>
        <LimitCounter used={value.length} ceiling={max} label="patterns" />
      </div>
    </div>
  );
}

export function ChannelTokens({
  guildId,
  value,
  onChange,
  max,
  label,
}: {
  guildId: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  max: number;
  label: string;
}): ReactElement {
  return (
    <div className="automod-add">
      <ChannelMultiPicker
        guildId={guildId}
        value={value}
        onChange={onChange}
        types={EXEMPT_CHANNEL_TYPES}
        max={max}
        label={label}
      />
      <LimitCounter used={value.length} ceiling={max} label="channels" />
    </div>
  );
}
