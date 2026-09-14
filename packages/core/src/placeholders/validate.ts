import { type BindContext, bindPlaceholder } from './bind.ts';
import type { PlaceholderRegistry } from './definitions.ts';
import { createReporter, type DiagnosticReporter, type TemplateDiagnostic } from './diagnostics.ts';
import { type ParsedTemplate, parseTemplate, type TemplateToken } from './grammar.ts';
import type { Sensitivity, TemplateField } from './limits.ts';

export interface ValidateOptions {
  registry: PlaceholderRegistry;
  field: TemplateField;
  event?: string | undefined;
  audience?: Sensitivity | undefined;
}

export interface ValidationResult {
  valid: boolean;
  tokens: readonly TemplateToken[];
  diagnostics: TemplateDiagnostic[];
}

const SCHEME = /[A-Za-z][A-Za-z0-9+.\-\t\n\r]*:/y;

function isIgnoredLead(character: string): boolean {
  return character.charCodeAt(0) <= 0x20 || /\s/.test(character);
}

function reportForeignScheme(tokens: readonly TemplateToken[], reporter: DiagnosticReporter): void {
  const [first] = tokens;
  if (first?.kind !== 'text') return;

  const { text, span } = first;
  let start = 0;
  while (start < text.length && isIgnoredLead(text.charAt(start))) start += 1;

  SCHEME.lastIndex = start;
  const match = SCHEME.exec(text);
  if (match === null) return;

  // Browsers drop tabs and newlines inside a URL, so java\tscript: is still javascript:.
  const scheme = match[0]
    .slice(0, -1)
    .replace(/[\t\n\r]/g, '')
    .toLowerCase();
  if (scheme === 'http' || scheme === 'https') return;

  reporter.report(
    'invalid_url',
    `this link starts with ${scheme}:, but a link must be an http or https address, so it renders empty.`,
    { start: span.start + start, end: span.start + start + match[0].length },
  );
}

export function validateTemplate(
  template: string | ParsedTemplate,
  options: ValidateOptions,
): ValidationResult {
  const parsed =
    typeof template === 'string' ? parseTemplate(template, options.registry) : template;
  const reporter = createReporter(parsed.diagnostics);

  if (options.field === 'url') reportForeignScheme(parsed.tokens, reporter);

  const context: BindContext = {
    registry: options.registry,
    field: options.field,
    event: options.event,
    audience: options.audience,
  };

  for (const token of parsed.tokens) {
    if (token.kind === 'placeholder') bindPlaceholder(token, context, reporter);
  }

  return { valid: reporter.errors === 0, tokens: parsed.tokens, diagnostics: reporter.diagnostics };
}
