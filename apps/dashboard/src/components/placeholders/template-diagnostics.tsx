import type { DiagnosticSeverity, SurfaceDiagnostic } from '@proton/core/placeholders';
import type { ReactElement } from 'react';

const SHOWN = 3;

const ORDER: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

const TONE: Record<DiagnosticSeverity, string> = {
  error: 'field-error',
  warning: 'field-warning',
  info: 'field-hint',
};

function identity(diagnostic: SurfaceDiagnostic): string {
  return `${diagnostic.severity}|${diagnostic.message}`;
}

export function visibleDiagnostics(diagnostics: readonly SurfaceDiagnostic[]): {
  shown: SurfaceDiagnostic[];
  more: number;
} {
  const unique = new Map<string, SurfaceDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = identity(diagnostic);
    if (!unique.has(key)) unique.set(key, diagnostic);
  }

  const sorted = [...unique.values()].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const listed = sorted.some(({ severity }) => severity !== 'info')
    ? sorted.filter(({ severity }) => severity !== 'info')
    : sorted;

  return { shown: listed.slice(0, SHOWN), more: Math.max(0, listed.length - SHOWN) };
}

export function TemplateDiagnostics({
  diagnostics,
  id,
}: {
  diagnostics: readonly SurfaceDiagnostic[];
  id: string;
}): ReactElement | null {
  const { shown, more } = visibleDiagnostics(diagnostics);
  if (shown.length === 0) return null;

  return (
    <ul id={id} className="template-diagnostics">
      {shown.map((diagnostic) => (
        <li key={identity(diagnostic)} className={TONE[diagnostic.severity]}>
          {diagnostic.message}
        </li>
      ))}
      {more > 0 ? <li className="field-hint">{`and ${more} more`}</li> : null}
    </ul>
  );
}
