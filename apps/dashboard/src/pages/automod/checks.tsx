import { normaliseDomain } from '@proton/core';
import type { AutomodCheck, AutomodConfig, Severity } from '@proton/module-automod/config';
import { AUTOMOD_CHECKS, automodConfigSchema, severityOf } from '@proton/module-automod/config';
import type { ReactElement, ReactNode } from 'react';
import { useMemo } from 'react';
import { DurationInput, humaniseDuration } from '../../components/discord/inputs.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import type { SegmentedOption } from '../../components/ui/controls.tsx';
import { Badge, NumberStepper, SegmentedControl } from '../../components/ui/controls.tsx';
import {
  DetailExplain,
  DetailField,
  ExpandableRow,
  Rows,
  Section,
} from '../../components/ui/layout.tsx';
import { PatternField, TokenField, type TokenIssue } from './lists.tsx';
import { setField } from './shape.ts';

type Form = ModuleForm<AutomodConfig>;

const SEVERITY_OPTIONS: readonly SegmentedOption<Severity>[] = [
  { value: 'off', label: 'Off', tone: 'off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium', tone: 'warning' },
  { value: 'high', label: 'High', tone: 'danger' },
];

interface CheckMeta {
  check: AutomodCheck;
  label: string;
  description: string;
}

const FLOOD: CheckMeta = {
  check: 'flood',
  label: 'Message flood',
  description: 'Detect too many messages sent in a short period.',
};

const DUPLICATE: CheckMeta = {
  check: 'duplicate',
  label: 'Duplicate messages',
  description: 'Detect repeated messages.',
};

const MENTIONS: CheckMeta = {
  check: 'mentions',
  label: 'Mass mentions',
  description: 'Detect messages that mention too many members or roles.',
};

const INVITES: CheckMeta = {
  check: 'invites',
  label: 'Invite links',
  description: 'Detect Discord invite links.',
};

const LINKS: CheckMeta = {
  check: 'links',
  label: 'Blocked links',
  description: 'Detect links to blocked domains.',
};

const ATTACHMENTS: CheckMeta = {
  check: 'attachments',
  label: 'Attachments',
  description: 'Detect attachments with a blocked file type.',
};

const PATTERNS: CheckMeta = {
  check: 'patterns',
  label: 'Custom patterns',
  description: 'Detect messages that match a regex pattern.',
};

const CAPS: CheckMeta = {
  check: 'caps',
  label: 'Shouting',
  description: 'Detect messages with too many capital letters.',
};

const EMOJI: CheckMeta = {
  check: 'emoji',
  label: 'Emoji spam',
  description: 'Detect messages with too many emoji.',
};

const WALLS: CheckMeta = {
  check: 'walls',
  label: 'Walls of text',
  description: 'Detect messages with too many lines.',
};

const ZALGO: CheckMeta = {
  check: 'zalgo',
  label: 'Zalgo text',
  description: 'Detect messages with stacked combining marks.',
};

function activeChecks(config: AutomodConfig): number {
  return AUTOMOD_CHECKS.filter((check) => severityOf(config, check) !== 'off').length;
}

function domainIssues(entries: readonly string[], allow: readonly string[]): TokenIssue[] {
  const allowed = new Set(
    allow.map(normaliseDomain).filter((domain): domain is string => domain !== null),
  );

  return entries.flatMap((entry) => {
    const normalised = normaliseDomain(entry);

    if (normalised === null) {
      return [{ token: entry, text: 'is not a domain Proton can read, so it never matches.' }];
    }

    if (allowed.has(normalised)) {
      return [
        {
          token: entry,
          text: 'is also in Allowed domains, which wins, so blocking it does nothing.',
        },
      ];
    }

    if (normalised !== entry) {
      return [{ token: entry, text: `is matched as ${normalised}, and so are its subdomains.` }];
    }

    return [];
  });
}

function allowIssues(entries: readonly string[]): TokenIssue[] {
  return entries.flatMap((entry) => {
    const normalised = normaliseDomain(entry);

    if (normalised === null) {
      return [{ token: entry, text: 'is not a domain Proton can read, so it never matches.' }];
    }

    if (normalised !== entry) {
      return [{ token: entry, text: `is matched as ${normalised}, and so are its subdomains.` }];
    }

    return [];
  });
}

function extensionIssues(entries: readonly string[]): TokenIssue[] {
  return entries.flatMap((entry) =>
    entry.startsWith('.')
      ? [
          {
            token: entry,
            text: 'never matches. Proton reads the text after the last dot, so leave the dot out.',
          },
        ]
      : [],
  );
}

/**
 * The refusals in `automodConfigSchema`'s superRefine carry the path `regexPatterns` with no index,
 * so the row they belong to is found by the pattern the message quotes.
 */
function patternIssues(config: AutomodConfig): ReadonlyMap<number, string> {
  const found = new Map<number, string>();
  const parsed = automodConfigSchema.safeParse(config);
  if (parsed.success) return found;

  for (const issue of parsed.error.issues) {
    if (issue.path[0] !== 'regexPatterns') continue;

    const at =
      typeof issue.path[1] === 'number'
        ? issue.path[1]
        : config.regexPatterns.findIndex((pattern) => issue.message.startsWith(`'${pattern}'`));

    if (at < 0 || found.has(at)) continue;
    found.set(at, issue.message);
  }

  return found;
}

function CheckRow({
  meta,
  form,
  detail,
  badge,
}: {
  meta: CheckMeta;
  form: Form;
  detail?: (() => ReactNode) | undefined;
  badge?: ReactNode;
}): ReactElement {
  const severity = severityOf(form.value, meta.check);

  return (
    <ExpandableRow
      title={meta.label}
      description={meta.description}
      badge={badge}
      detail={severity === 'off' ? undefined : detail}
      control={
        <SegmentedControl
          accent
          label={`${meta.label} severity`}
          options={SEVERITY_OPTIONS}
          value={severity}
          onChange={(next) =>
            form.setValue((config) => setField(config, `${meta.check}Severity`, next))
          }
        />
      }
    />
  );
}

function WideDetail({ explain, children }: { explain: string; children: ReactNode }): ReactElement {
  return (
    <div className="automod-detail-wide stack stack-12">
      <p className="automod-explain">{explain}</p>
      {children}
    </div>
  );
}

export function ChecksArea({ form }: { form: Form }): ReactElement {
  const config = form.value;

  const patterns = useMemo(
    () =>
      severityOf(config, 'patterns') === 'off' ? new Map<number, string>() : patternIssues(config),
    [config],
  );

  const neverMatches = <Badge tone="warning">Never matches</Badge>;

  return (
    <>
      <p className="automod-tally">
        <strong>{activeChecks(config)}</strong> of {AUTOMOD_CHECKS.length} checks on. When several
        checks match one message, the highest severity decides the action.
      </p>

      <Section label="Spam">
        <Rows>
          <CheckRow
            meta={FLOOD}
            form={form}
            detail={() => (
              <>
                <DetailField label="Message limit">
                  <NumberStepper
                    label="Message limit"
                    value={config.floodCount}
                    min={2}
                    max={50}
                    onChange={(next) =>
                      form.setValue((current) =>
                        setField(current, 'floodCount', next ?? current.floodCount),
                      )
                    }
                  />
                </DetailField>
                <DetailField label="Flood window">
                  <DurationInput
                    label="Flood window"
                    value={config.floodWindow}
                    onChange={(next) =>
                      form.setValue((current) => setField(current, 'floodWindow', next))
                    }
                  />
                </DetailField>
                <DetailExplain>
                  Acts when one member sends {config.floodCount} messages within{' '}
                  {humaniseDuration(config.floodWindow)}.
                </DetailExplain>
              </>
            )}
          />

          <CheckRow
            meta={DUPLICATE}
            form={form}
            detail={() => (
              <>
                <DetailField label="Repeat limit">
                  <NumberStepper
                    label="Repeat limit"
                    value={config.duplicateCount}
                    min={2}
                    max={50}
                    onChange={(next) =>
                      form.setValue((current) =>
                        setField(current, 'duplicateCount', next ?? current.duplicateCount),
                      )
                    }
                  />
                </DetailField>
                <DetailField label="Duplicate window">
                  <DurationInput
                    label="Duplicate window"
                    value={config.duplicateWindow}
                    onChange={(next) =>
                      form.setValue((current) => setField(current, 'duplicateWindow', next))
                    }
                  />
                </DetailField>
                <DetailExplain>
                  Acts when one member sends the same message {config.duplicateCount} times within{' '}
                  {humaniseDuration(config.duplicateWindow)}. Messages shorter than 8 characters are
                  not counted.
                </DetailExplain>
              </>
            )}
          />

          <CheckRow
            meta={MENTIONS}
            form={form}
            detail={() => (
              <>
                <DetailField label="Mention limit">
                  <NumberStepper
                    label="Mention limit"
                    value={config.mentionsLimit}
                    min={1}
                    max={50}
                    onChange={(next) =>
                      form.setValue((current) =>
                        setField(current, 'mentionsLimit', next ?? current.mentionsLimit),
                      )
                    }
                  />
                </DetailField>
                <DetailExplain>
                  Acts when one message mentions {config.mentionsLimit} or more members and roles.
                  @everyone and @here always match.
                </DetailExplain>
              </>
            )}
          />
        </Rows>
      </Section>

      <Section label="Content">
        <Rows>
          <CheckRow meta={INVITES} form={form} />

          <CheckRow
            meta={LINKS}
            form={form}
            badge={
              severityOf(config, 'links') !== 'off' && config.linkBlockDomains.length === 0
                ? neverMatches
                : undefined
            }
            detail={() => (
              <WideDetail
                explain={
                  config.linkBlockDomains.length === 0
                    ? 'No blocked domains, so this check never matches.'
                    : 'Acts on links to a blocked domain or any of its subdomains. Allowed domains win, even when a parent domain is blocked.'
                }
              >
                <DetailField label="Blocked domains">
                  <TokenField
                    mono
                    label="Blocked domains"
                    countLabel="domains"
                    placeholder="example.com"
                    max={200}
                    maxLength={253}
                    searchFrom={25}
                    value={config.linkBlockDomains}
                    issues={domainIssues(config.linkBlockDomains, config.linkAllowDomains)}
                    onChange={(next) =>
                      form.setValue((current) => setField(current, 'linkBlockDomains', next))
                    }
                  />
                </DetailField>
                <DetailField label="Allowed domains">
                  <TokenField
                    mono
                    label="Allowed domains"
                    countLabel="domains"
                    placeholder="docs.example.com"
                    max={200}
                    maxLength={253}
                    searchFrom={25}
                    value={config.linkAllowDomains}
                    issues={allowIssues(config.linkAllowDomains)}
                    onChange={(next) =>
                      form.setValue((current) => setField(current, 'linkAllowDomains', next))
                    }
                  />
                </DetailField>
              </WideDetail>
            )}
          />

          <CheckRow
            meta={ATTACHMENTS}
            form={form}
            badge={
              severityOf(config, 'attachments') !== 'off' &&
              config.attachmentExtensions.length === 0
                ? neverMatches
                : undefined
            }
            detail={() => (
              <WideDetail
                explain={
                  config.attachmentExtensions.length === 0
                    ? 'No blocked file types, so this check never matches.'
                    : 'Acts on files whose last extension is on this list, and on disguised double extensions such as invoice.exe.pdf.'
                }
              >
                <DetailField label="Blocked file types">
                  <TokenField
                    mono
                    label="Blocked file types"
                    countLabel="file types"
                    placeholder="exe"
                    max={100}
                    maxLength={16}
                    value={config.attachmentExtensions}
                    issues={extensionIssues(config.attachmentExtensions)}
                    normalise={(raw) => raw.trim().toLowerCase()}
                    onChange={(next) =>
                      form.setValue((current) => setField(current, 'attachmentExtensions', next))
                    }
                  />
                </DetailField>
              </WideDetail>
            )}
          />

          <CheckRow
            meta={PATTERNS}
            form={form}
            badge={
              severityOf(config, 'patterns') !== 'off' && config.regexPatterns.length === 0
                ? neverMatches
                : undefined
            }
            detail={() => (
              <WideDetail
                explain={
                  config.regexPatterns.length === 0
                    ? 'No patterns, so this check never matches.'
                    : 'Proton runs every pattern. Discord AutoMod also runs the ones tagged Discord.'
                }
              >
                <DetailField label="Regex patterns">
                  <PatternField
                    max={10}
                    value={config.regexPatterns}
                    issueAt={(index) => patterns.get(index)}
                    onChange={(next) =>
                      form.setValue((current) => setField(current, 'regexPatterns', next))
                    }
                  />
                </DetailField>
              </WideDetail>
            )}
          />
        </Rows>
      </Section>

      <Section label="Formatting">
        <Rows>
          <CheckRow
            meta={CAPS}
            form={form}
            detail={() => (
              <>
                <DetailField label="Capital letter limit">
                  <NumberStepper
                    label="Capital letter limit"
                    unit="%"
                    width={132}
                    value={config.capsRatio}
                    min={50}
                    max={100}
                    onChange={(next) =>
                      form.setValue((current) =>
                        setField(current, 'capsRatio', next ?? current.capsRatio),
                      )
                    }
                  />
                </DetailField>
                <DetailExplain>
                  Acts when {config.capsRatio}% or more of a message is capital letters. Messages
                  with fewer than 12 letters are not counted, and links, custom emoji and mentions
                  are ignored.
                </DetailExplain>
              </>
            )}
          />

          <CheckRow
            meta={EMOJI}
            form={form}
            detail={() => (
              <>
                <DetailField label="Emoji limit">
                  <NumberStepper
                    label="Emoji limit"
                    value={config.emojiLimit}
                    min={1}
                    max={100}
                    onChange={(next) =>
                      form.setValue((current) =>
                        setField(current, 'emojiLimit', next ?? current.emojiLimit),
                      )
                    }
                  />
                </DetailField>
                <DetailExplain>
                  Acts when one message has {config.emojiLimit} or more emoji. Custom emoji count
                  too.
                </DetailExplain>
              </>
            )}
          />

          <CheckRow
            meta={WALLS}
            form={form}
            detail={() => (
              <>
                <DetailField label="Line limit">
                  <NumberStepper
                    label="Line limit"
                    value={config.wallMaxLines}
                    min={2}
                    max={200}
                    onChange={(next) =>
                      form.setValue((current) =>
                        setField(current, 'wallMaxLines', next ?? current.wallMaxLines),
                      )
                    }
                  />
                </DetailField>
                <DetailExplain>
                  Acts when a message has {config.wallMaxLines} or more lines.
                </DetailExplain>
              </>
            )}
          />

          <CheckRow meta={ZALGO} form={form} />
        </Rows>
      </Section>

      <p className="automod-note">
        Exemptions apply before any check runs, so exempt messages never count toward the flood or
        duplicate limits.
      </p>
    </>
  );
}
