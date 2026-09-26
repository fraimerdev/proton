import type { DiagnosticSeverity, Span, SurfaceDiagnostic } from '@proton/core/placeholders';
import type { ReactElement } from 'react';
import {
  type PlaceholderCatalogue,
  usePlaceholderCatalogue,
} from '../../lib/placeholder-catalogue.ts';
import { sentence } from '../discord/embed-editor.tsx';

const SHOWN = 3;

const ORDER: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

const TONE: Record<DiagnosticSeverity, string> = {
  error: 'field-error',
  warning: 'field-warning',
  info: 'field-hint',
};

const NAMED_ELSEWHERE = 2;

export interface DiagnosticsSource {
  pending: Span | null;
  text: string;
}

function identity(diagnostic: SurfaceDiagnostic): string {
  return `${diagnostic.severity}|${diagnostic.message}`;
}

function touches(span: Span | null, pending: Span | null): boolean {
  if (span === null || pending === null) return false;
  return span.start <= pending.end && pending.start <= span.end;
}

export function visibleDiagnostics(
  diagnostics: readonly SurfaceDiagnostic[],
  pending: Span | null = null,
): {
  shown: SurfaceDiagnostic[];
  more: number;
} {
  const unique = new Map<string, SurfaceDiagnostic>();
  for (const diagnostic of diagnostics) {
    if (touches(diagnostic.span, pending)) continue;

    const key = identity(diagnostic);
    if (!unique.has(key)) unique.set(key, diagnostic);
  }

  const sorted = [...unique.values()].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const listed = sorted.some(({ severity }) => severity !== 'info')
    ? sorted.filter(({ severity }) => severity !== 'info')
    : sorted;

  return { shown: listed.slice(0, SHOWN), more: Math.max(0, listed.length - SHOWN) };
}

export function unknownKeyAt(text: string, span: Span | null): string | undefined {
  if (span === null) return undefined;

  const raw = text.slice(span.start, span.end);
  if (!raw.startsWith('{')) return undefined;

  const key = raw.slice(1).split(/[:}]/, 1)[0];
  return key === undefined || key === '' ? undefined : key;
}

function namedPlaces(labels: readonly string[]): string {
  const named = labels.slice(0, NAMED_ELSEWHERE).map((label) => `the ${label.toLowerCase()}`);
  const more = labels.length - named.length;

  if (more > 0) return `${named.join(', ')} and ${more} more`;
  return named.length === 2 ? `${named[0]} or ${named[1]}` : (named[0] ?? '');
}

export function elsewhereMessage(key: string, labels: readonly string[]): string | undefined {
  if (labels.length === 0) return undefined;
  return `{${key}} only works in ${namedPlaces(labels)}, so it's posted as written here.`;
}

function explained(
  diagnostic: SurfaceDiagnostic,
  source: DiagnosticsSource | undefined,
  catalogue: PlaceholderCatalogue | null,
): string {
  if (diagnostic.code !== 'unknown_placeholder' || source === undefined || catalogue === null) {
    return diagnostic.message;
  }

  const key = unknownKeyAt(source.text, diagnostic.span);
  if (key === undefined) return diagnostic.message;

  return elsewhereMessage(key, catalogue.whereKeyWorks(key)) ?? diagnostic.message;
}

export function TemplateDiagnostics({
  diagnostics,
  id,
  autocomplete,
}: {
  diagnostics: readonly SurfaceDiagnostic[];
  id: string;
  autocomplete?: DiagnosticsSource | undefined;
}): ReactElement | null {
  const { shown, more } = visibleDiagnostics(diagnostics, autocomplete?.pending ?? null);
  const catalogue = usePlaceholderCatalogue(
    autocomplete !== undefined && shown.some(({ code }) => code === 'unknown_placeholder'),
  );

  if (shown.length === 0) return null;

  return (
    <ul id={id} className="template-diagnostics">
      {shown.map((diagnostic) => (
        <li key={identity(diagnostic)} className={TONE[diagnostic.severity]}>
          {sentence(explained(diagnostic, autocomplete, catalogue))}
        </li>
      ))}
      {more > 0 ? <li className="field-hint">{`and ${more} more`}</li> : null}
    </ul>
  );
}
