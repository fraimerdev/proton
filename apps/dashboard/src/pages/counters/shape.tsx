import {
  mentionsAny,
  parseTemplate,
  SAMPLE_NOW,
  type SurfaceDiagnostic,
  type TemplateReport,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import {
  COUNT_PLACEHOLDER,
  COUNTER_SOURCES,
  type Counter,
  type CounterSource,
  type CountersConfig,
  counterSchema,
} from '@proton/module-counters/config';
import {
  COUNT_KEYS,
  COUNTER_SURFACE,
  countersTemplates,
  countFor,
  renderCounterName,
} from '@proton/module-counters/placeholders';
import { Fragment, type ReactElement, useId, useMemo } from 'react';
import type { ModuleForm } from '../../components/module/form.ts';
import { visibleDiagnostics } from '../../components/placeholders/template-diagnostics.tsx';
import {
  type PlaceholderAutocomplete,
  usePlaceholderAutocomplete,
} from '../../components/placeholders/use-placeholder-autocomplete.ts';
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

export const NEW_COUNTER_PATH = 'counters.0.template';

const NO_DIAGNOSTICS: readonly SurfaceDiagnostic[] = [];

function sampleState(): CounterSampleState {
  const sample = COUNTER_SURFACE.samples[0];
  if (sample === undefined) {
    throw new Error(
      'The counter placeholders have no sample, so no channel name can be previewed.',
    );
  }
  return sample.facts.state;
}

type CounterSampleState = (typeof COUNTER_SURFACE.samples)[number]['facts']['state'];

const SAMPLE_STATE = sampleState();

function sampleCount(source: CounterSource): string {
  return (countFor(source, SAMPLE_STATE) ?? 0).toLocaleString('en-GB');
}

const SAMPLE_NOTE =
  `Sample server with ${sampleCount('members')} members, ${sampleCount('roles')} roles and ` +
  `${sampleCount('channels')} channels. Proton fills in your server’s numbers every 10 minutes.`;

const EMPTY_NAME =
  'Empty with the sample numbers. Proton never renames a channel to an empty name.';

export function setCounters(form: CountersForm, counters: Counter[]): void {
  form.setValue((current) => ({ ...current, counters }));
}

export function hasCount(template: string): boolean {
  return template.includes(COUNT_PLACEHOLDER) || mentionsAny(COUNTER_SURFACE, template, COUNT_KEYS);
}

export function prefillFor(source: CounterSource): string {
  return `${SOURCE_LABEL[source]}: ${COUNT_PLACEHOLDER}`;
}

// Derived, never typed: an edited id would orphan the channel Proton filed under it.
export function nextCounterId(counters: readonly Counter[], source: CounterSource): string {
  const used = new Set(counters.map((counter) => counter.id));
  if (!used.has(source)) return source;

  let n = 2;
  while (used.has(`${source}-${n}`)) n += 1;

  return `${source}-${n}`;
}

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

export function useCounterTemplates(form: CountersForm): TemplateReport {
  const { value, view } = form;
  return useMemo(
    () => validateConfigTemplates(countersTemplates, value, view.config),
    [value, view.config],
  );
}

export function newCounterReport(counter: Counter): TemplateReport {
  return validateConfigTemplates(countersTemplates, { counters: [counter] });
}

export interface TemplateField {
  autocomplete: PlaceholderAutocomplete;
  diagnostics: readonly SurfaceDiagnostic[];
  diagnosticsId: string;
  describedBy: string | undefined;
  invalid: boolean;
  error: string | undefined;
}

export function useTemplateField({
  report,
  path,
  onChange,
  error,
}: {
  report: TemplateReport;
  path: string;
  onChange: (next: string) => void;
  error: string | undefined;
}): TemplateField {
  const diagnosticsId = useId();
  const diagnostics = report.byPath.get(path) ?? NO_DIAGNOSTICS;
  const autocomplete = usePlaceholderAutocomplete({ surface: COUNTER_SURFACE, path, onChange });
  const listed = error !== undefined && diagnostics.some(({ message }) => message === error);

  return {
    autocomplete,
    diagnostics,
    diagnosticsId,
    describedBy: visibleDiagnostics(diagnostics).shown.length > 0 ? diagnosticsId : undefined,
    invalid: error !== undefined || report.blocking.some((issue) => issue.path === path),
    error: listed ? undefined : error,
  };
}

export function TemplateName({ template }: { template: string }): ReactElement {
  const { tokens } = parseTemplate(template, COUNTER_SURFACE.registry);

  return (
    <>
      {tokens.map((token) => {
        const written = template.slice(token.span.start, token.span.end);

        return token.kind === 'placeholder' ? (
          <span key={token.span.start} className="counter-token">
            {written}
          </span>
        ) : (
          <Fragment key={token.span.start}>{written}</Fragment>
        );
      })}
    </>
  );
}

export function NamePreview({
  template,
  source,
  icon,
}: {
  template: string;
  source: CounterSource;
  icon: IconName;
}): ReactElement {
  const name =
    template === ''
      ? ''
      : renderCounterName(template, { source, state: SAMPLE_STATE }, SAMPLE_NOW).output;

  return (
    <>
      <div className="counter-preview">
        <Icon name={icon} size={14} />
        {name === '' ? (
          <span className="text-muted">{template === '' ? 'No name' : EMPTY_NAME}</span>
        ) : (
          <span className="counter-preview-name">{name}</span>
        )}
      </div>
      <span className="field-hint">{SAMPLE_NOTE}</span>
    </>
  );
}
