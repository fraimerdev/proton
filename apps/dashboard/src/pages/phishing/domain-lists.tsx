import {
  DOMAIN_MAX_LENGTH,
  domainCandidates,
  firstMatch,
  normaliseDomain,
  toDomainSet,
  zodToDescriptors,
} from '@proton/core';
import { type PhishingConfig, phishingConfigSchema } from '@proton/module-phishing/config';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { LimitCounter } from '../../components/ui/collection.tsx';
import { Button, IconButton, SearchField, TextInput } from '../../components/ui/controls.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Rows, Section } from '../../components/ui/layout.tsx';
import { SegmentedTabs } from '../../components/ui/tabs.tsx';

type ListKey = 'blockDomains' | 'allowDomains';

// GUILD_LIST_MAX is module-private, so the ceiling is read off the schema rather than transcribed.
const LIST_MAX =
  zodToDescriptors(phishingConfigSchema).find((field) => field.path === 'blockDomains')?.maxItems ??
  100;

const FILTER_FROM = 10;

const LIST_LABEL: Record<ListKey, string> = {
  blockDomains: 'Extra blocked domains',
  allowDomains: 'Allowed domains',
};

const LIST_CAPTION: Record<ListKey, string | undefined> = {
  blockDomains: undefined,
  allowDomains: 'Ignore links to these domains, even when the community blocklist includes them.',
};

const LIST_EMPTY: Record<ListKey, string> = {
  blockDomains:
    'No extra blocked domains. Links are still checked against the community blocklist.',
  allowDomains: 'No allowed domains. Add one if Proton blocks a domain it should not.',
};

const NOT_A_DOMAIN = 'Not a domain Proton can read. Use a hostname such as example.com.';
const TOO_LONG = `Too long. A domain can be at most ${DOMAIN_MAX_LENGTH} characters.`;
const ALREADY_HERE = 'Already in this list.';
const AT_CEILING = `You can add up to ${LIST_MAX} domains. Remove one to add another.`;

interface Draft {
  // -1 is the pending new row above the list; anything else is the entry at that index.
  index: number;
  text: string;
  error: string | null;
}

function withList(config: PhishingConfig, key: ListKey, next: string[]): PhishingConfig {
  return key === 'blockDomains'
    ? { ...config, blockDomains: next }
    : { ...config, allowDomains: next };
}

function shadowReason(domain: string, allowed: ReadonlySet<string>): string | null {
  const host = normaliseDomain(domain);
  if (host === null) return null;

  const shadow = firstMatch({ host, candidates: domainCandidates(host) }, allowed);
  if (shadow === null) return null;

  return shadow === host
    ? 'Also in Allowed domains, which wins, so this entry has no effect.'
    : `Covered by ${shadow} in Allowed domains, which wins, so this entry has no effect.`;
}

function DomainEditor({
  draft,
  onText,
  onCommit,
  onCancel,
}: {
  draft: Draft;
  onText: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div className="phishing-domain">
      <div className="phishing-domain-edit">
        <TextInput
          autoFocus
          className="phishing-domain-input"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label="Domain"
          placeholder="example.com"
          invalid={draft.error !== null}
          maxLength={DOMAIN_MAX_LENGTH}
          value={draft.text}
          onChange={(event) => onText(event.currentTarget.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onCommit();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
        />
        <IconButton
          icon="check"
          label="Save domain"
          size="sm"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCommit}
        />
        <IconButton
          icon="x"
          label="Cancel"
          tone="ghost"
          size="sm"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCancel}
        />
      </div>
      {draft.error !== null ? (
        <p className="phishing-domain-error" role="alert">
          {draft.error}
        </p>
      ) : null}
    </div>
  );
}

function DomainRow({
  domain,
  warning,
  error,
  onEdit,
  onRemove,
}: {
  domain: string;
  warning: string | null;
  error: string | undefined;
  onEdit: () => void;
  onRemove: () => void;
}): ReactElement {
  return (
    <div className="phishing-domain">
      <div className="phishing-domain-line">
        <button type="button" className="phishing-domain-open" onClick={onEdit}>
          <span className="mono truncate">{domain}</span>
        </button>
        <IconButton
          icon="trash"
          label={`Remove ${domain}`}
          tone="ghost"
          size="sm"
          onClick={onRemove}
        />
      </div>
      {error !== undefined ? (
        <p className="phishing-domain-error" role="alert">
          {error}
        </p>
      ) : null}
      {warning !== null ? (
        <p className="phishing-domain-warning">
          <Icon name="warning" size={13} weight="fill" />
          {warning}
        </p>
      ) : null}
    </div>
  );
}

export function DomainLists({
  value,
  onChange,
  errorAt,
}: {
  value: PhishingConfig;
  onChange: (next: PhishingConfig) => void;
  errorAt: (path: string) => string | undefined;
}): ReactElement {
  const [active, setActive] = useState<ListKey>('blockDomains');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);

  const list = value[active];
  const allowed = useMemo(() => toDomainSet(value.allowDomains), [value.allowDomains]);

  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return list
      .map((domain, index) => ({ domain, index }))
      .filter((entry) => needle === '' || entry.domain.toLowerCase().includes(needle));
  }, [list, query]);

  const atCeiling = list.length >= LIST_MAX;
  const caption = LIST_CAPTION[active];

  const switchTo = (next: ListKey): void => {
    setActive(next);
    setQuery('');
    setDraft(null);
  };

  const commit = (): void => {
    if (draft === null) return;

    const raw = draft.text.trim();
    if (raw === '') {
      setDraft(null);
      return;
    }

    const domain = normaliseDomain(raw);
    if (domain === null) {
      setDraft({ ...draft, error: raw.length > DOMAIN_MAX_LENGTH ? TOO_LONG : NOT_A_DOMAIN });
      return;
    }

    const clash = list.some(
      (entry, index) => index !== draft.index && normaliseDomain(entry) === domain,
    );
    if (clash) {
      setDraft({ ...draft, error: ALREADY_HERE });
      return;
    }

    onChange(
      withList(
        value,
        active,
        draft.index === -1
          ? [domain, ...list]
          : list.map((entry, index) => (index === draft.index ? domain : entry)),
      ),
    );
    setDraft(null);
  };

  const remove = (index: number): void => {
    setDraft(null);
    onChange(
      withList(
        value,
        active,
        list.filter((_, position) => position !== index),
      ),
    );
  };

  return (
    <Section label="Domain lists">
      <div className="phishing-list-bar">
        <SegmentedTabs
          label="Domain list"
          value={active}
          onChange={switchTo}
          items={[
            { id: 'blockDomains', label: LIST_LABEL.blockDomains },
            { id: 'allowDomains', label: LIST_LABEL.allowDomains },
          ]}
        />
        <LimitCounter used={list.length} ceiling={LIST_MAX} label="domains" />
        <span className="push-right" />
        {/* A live term keeps the box: without it, deleting past FILTER_FROM hides the rest. */}
        {list.length > FILTER_FROM || query !== '' ? (
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search domains…"
            label="Search domains"
            className="phishing-filter"
          />
        ) : null}
        <Button
          icon="plus"
          disabled={atCeiling}
          onClick={() => {
            setQuery('');
            setDraft({ index: -1, text: '', error: null });
          }}
        >
          Add domain
        </Button>
      </div>

      <div className="phishing-help">
        {caption !== undefined ? <p>{caption}</p> : null}
        <p>
          Both lists include subdomains: <span className="mono">example.com</span> also covers{' '}
          <span className="mono">login.example.com</span>. Proton checks Allowed domains first, then
          Extra blocked domains, then the community blocklist.
        </p>
        <p>
          Proton refreshes the community blocklist every hour. Use{' '}
          <span className="mono">/phishing</span> in Discord to see how many domains it holds and
          whether a feed is failing.
        </p>
        {atCeiling ? <p className="text-warning">{AT_CEILING}</p> : null}
        {errorAt(active) !== undefined ? (
          <p className="text-danger" role="alert">
            {errorAt(active)}
          </p>
        ) : null}
      </div>

      <Rows>
        {draft !== null && draft.index === -1 ? (
          <DomainEditor
            draft={draft}
            onText={(text) => setDraft({ index: -1, text, error: null })}
            onCommit={commit}
            onCancel={() => setDraft(null)}
          />
        ) : null}

        {entries.map(({ domain, index }) =>
          draft !== null && draft.index === index ? (
            <DomainEditor
              key={`${domain}:${index}`}
              draft={draft}
              onText={(text) => setDraft({ index, text, error: null })}
              onCommit={commit}
              onCancel={() => setDraft(null)}
            />
          ) : (
            <DomainRow
              key={`${domain}:${index}`}
              domain={domain}
              warning={active === 'blockDomains' ? shadowReason(domain, allowed) : null}
              error={errorAt(`${active}.${index}`)}
              onEdit={() => setDraft({ index, text: domain, error: null })}
              onRemove={() => remove(index)}
            />
          ),
        )}

        {entries.length === 0 && draft === null ? (
          <p className="phishing-domain-empty">
            {list.length === 0 ? LIST_EMPTY[active] : 'No matching domains'}
          </p>
        ) : null}
      </Rows>
    </Section>
  );
}
