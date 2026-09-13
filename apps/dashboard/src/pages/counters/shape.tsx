import {
  COUNT_PLACEHOLDER,
  COUNTER_SOURCES,
  type Counter,
  type CounterSource,
  type CountersConfig,
  counterSchema,
} from '@proton/module-counters/config';
import { Fragment, type ReactElement } from 'react';
import type { ModuleForm } from '../../components/module/form.ts';
import { Icon, type IconName } from '../../components/ui/icon.tsx';

export type CountersForm = ModuleForm<CountersConfig>;

export const SOURCE_LABEL: Record<CounterSource, string> = {
  members: 'Members',
  roles: 'Roles',
  channels: 'Channels',
};

export const SOURCE_ICON: Record<CounterSource, IconName> = {
  members: 'users-three',
  roles: 'tag',
  channels: 'hash',
};

export const SOURCE_OPTIONS = COUNTER_SOURCES.map((source) => ({
  value: source,
  label: SOURCE_LABEL[source],
}));

export const EMPTY_TEMPLATE = 'A counter needs a name template. It becomes the channel name.';

export const CHANNEL_TAKEN =
  'two counters cannot share a channel — they would rename it in turn and each one would spend ' +
  'the other’s rename allowance.';

export function setCounters(form: CountersForm, counters: Counter[]): void {
  form.setValue((current) => ({ ...current, counters }));
}

export function hasCount(template: string): boolean {
  return template.includes(COUNT_PLACEHOLDER);
}

export function prefillFor(source: CounterSource): string {
  return `${SOURCE_LABEL[source]}: ${COUNT_PLACEHOLDER}`;
}

/** Derived, never typed: an id the admin edited would orphan the channel Proton filed under it. */
export function nextCounterId(counters: readonly Counter[], source: CounterSource): string {
  const used = new Set(counters.map((counter) => counter.id));
  if (!used.has(source)) return source;

  let n = 2;
  while (used.has(`${source}-${n}`)) n += 1;

  return `${source}-${n}`;
}

/**
 * The counter's own schema answering for its own fields, so the message beside a field is the one
 * the save would return rather than a second copy of it that can drift.
 */
export function counterIssues(counter: Counter): ReadonlyMap<string, string> {
  const parsed = counterSchema.safeParse(counter);
  if (parsed.success) return new Map();

  const issues = new Map<string, string>();

  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String).join('.');
    if (!issues.has(path)) issues.set(path, issue.message);
  }

  return issues;
}

export function channelTaken(counters: readonly Counter[], index: number): boolean {
  const counter = counters[index];
  if (!counter || counter.channelId === undefined) return false;

  return counters.some((other, at) => at !== index && other.channelId === counter.channelId);
}

export function brokenCounters(counters: readonly Counter[]): ReadonlySet<number> {
  const broken = new Set<number>();
  const seen = new Set<string>();

  for (const [index, counter] of counters.entries()) {
    if (counter.template === '' || counterIssues(counter).size > 0) broken.add(index);

    if (counter.channelId !== undefined) {
      if (seen.has(counter.channelId)) broken.add(index);
      seen.add(counter.channelId);
    }
  }

  return broken;
}

export function withChannel(counter: Counter, channelId: string | null): Counter {
  const next = { ...counter };

  if (channelId === null) delete next.channelId;
  else next.channelId = channelId;

  return next;
}

/**
 * The template with {count} left standing as a token. The dashboard cannot read the count the
 * refresh will use — it comes from the gateway's own guild state — so putting a number here would
 * be a guess dressed as a preview.
 */
export function TemplateName({ template }: { template: string }): ReactElement {
  const parts = template.split(COUNT_PLACEHOLDER);

  return (
    <>
      {parts.map((part, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of a split have no identity
        <Fragment key={at}>
          {at > 0 ? <span className="counter-token">{COUNT_PLACEHOLDER}</span> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

export function NamePreview({
  template,
  icon,
}: {
  template: string;
  icon: IconName;
}): ReactElement {
  return (
    <div className="counter-preview">
      <Icon name={icon} size={14} />
      {template === '' ? (
        <span className="text-muted">No name</span>
      ) : (
        <span className="counter-preview-name">
          <TemplateName template={template} />
        </span>
      )}
    </div>
  );
}
