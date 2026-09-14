import type { Span, TemplateDiagnostic } from './diagnostics.ts';
import type { PlaceholderToken, TemplateToken } from './grammar.ts';
import {
  isMessageLike,
  type MentionSettings,
  mentionSettingsOf,
  visitTemplatePaths,
} from './message-fields.ts';
import {
  type PingKind,
  type PlaceholderSurface,
  SURFACE_DIAGNOSTIC_SEVERITY,
  type SurfaceDiagnostic,
  type SurfaceDiagnosticCode,
  suggestKey,
  type TemplateFieldSpec,
} from './surface.ts';
import { validateTemplate } from './validate.ts';
import { fieldAccepts } from './values.ts';

export interface TemplateSite {
  path: string;
  surfaceId: string;
  spec: TemplateFieldSpec;
  text: string;
  mentions?: MentionSettings | undefined;
}

export interface ModuleTemplates {
  surfaces: Readonly<Record<string, PlaceholderSurface<unknown>>>;
  collect(config: unknown): TemplateSite[];
}

export interface TemplateIssue {
  path: string;
  label: string;
  diagnostic: TemplateDiagnostic;
}

export interface TemplateReport {
  byPath: ReadonlyMap<string, readonly SurfaceDiagnostic[]>;
  blocking: readonly TemplateIssue[];
}

export function collectConfigTemplates(
  config: unknown,
  surface: Pick<PlaceholderSurface<unknown>, 'id' | 'fields'>,
): TemplateSite[] {
  const sites: TemplateSite[] = [];

  for (const spec of surface.fields) {
    visitTemplatePaths(config, spec.path, ({ segments, text, ancestors }) => {
      const site: TemplateSite = { path: segments.join('.'), surfaceId: surface.id, spec, text };

      if (spec.kind === 'discord_text') {
        const message = [...ancestors].reverse().find(isMessageLike);
        if (message !== undefined) site.mentions = mentionSettingsOf(message);
      }

      sites.push(site);
    });
  }

  return sites;
}

const DOUBLED = /\{\{|\}\}/;

const PING_COPY: Record<PingKind, (raw: string) => string> = {
  roles: (raw) =>
    `${raw} writes role mentions, and this message's mention settings let roles be pinged, so every listed role is pinged when it posts. Turn off role pings under Mentions if that is not wanted.`,
  users: (raw) =>
    `${raw} writes a user mention, and this message's mention settings let users be pinged, so that person is pinged when it posts. Turn off user pings under Mentions if that is not wanted.`,
};

function isPlaceholder(token: TemplateToken): token is PlaceholderToken {
  return token.kind === 'placeholder';
}

function withSuggestion(
  diagnostic: TemplateDiagnostic,
  surface: PlaceholderSurface<unknown>,
  tokens: readonly TemplateToken[],
): TemplateDiagnostic {
  if (diagnostic.code !== 'unknown_placeholder' || diagnostic.span === null) return diagnostic;

  const { start } = diagnostic.span;
  const token = tokens.filter(isPlaceholder).find((candidate) => candidate.span.start === start);
  const suggestion = token === undefined ? undefined : suggestKey(surface.registry, token.key);

  return suggestion === undefined
    ? diagnostic
    : { ...diagnostic, message: `${diagnostic.message} Did you mean {${suggestion}}?` };
}

function surfaceDiagnostics(
  site: TemplateSite,
  surface: PlaceholderSurface<unknown>,
  tokens: readonly TemplateToken[],
  prior: string | undefined,
): SurfaceDiagnostic[] {
  const found: SurfaceDiagnostic[] = [];
  const report = (code: SurfaceDiagnosticCode, message: string, span: Span | null): void => {
    found.push({ code, severity: SURFACE_DIAGNOSTIC_SEVERITY[code], message, span });
  };

  const { kind, label } = site.spec;
  const doubled = DOUBLED.exec(site.text);

  if (doubled !== null && prior !== site.text && (prior === undefined || !DOUBLED.test(prior))) {
    report(
      'doubled_brace_literal',
      '{{ now means a literal { and }} a literal }, so doubled braces here are posted as single ones.',
      { start: doubled.index, end: doubled.index + 2 },
    );
  }

  const pinged = new Set<string>();

  for (const token of tokens.filter(isPlaceholder)) {
    const resolution = surface.registry.resolve(token.key);
    if (resolution === undefined) continue;

    const { definition, canonical } = resolution;
    const modifiers = token.modifiers.map(({ name }) => name);

    if (resolution.alias && kind !== 'url') {
      report(
        'legacy_alias',
        `${token.raw} is an older name for {${canonical}}, which is the name the suggestions insert. Both work here.`,
        token.span,
      );
    } else if (resolution.alias && fieldAccepts(kind, definition.type)) {
      report(
        'legacy_alias_in_url',
        `${token.raw} in a link is now written link-safe, so spaces become %20.`,
        token.span,
      );
    }

    const mentions = definition.type === 'mention' || definition.type === 'list<mention>';

    if (kind === 'plain_text' && mentions && !modifiers.includes('count')) {
      report(
        'plain_text_value',
        `${label} cannot ping or show mentions, so ${token.raw} shows a name here.`,
        token.span,
      );
    }

    if (kind === 'plain_text' && definition.type === 'datetime' && !modifiers.includes('unix')) {
      report(
        'plain_text_value',
        `${label} cannot show Discord timestamps, so ${token.raw} shows a readable date here.`,
        token.span,
      );
    }

    const ping = Object.hasOwn(surface.pings, canonical) ? surface.pings[canonical] : undefined;

    if (
      ping !== undefined &&
      kind === 'discord_text' &&
      site.mentions?.[ping] === true &&
      !modifiers.includes('count') &&
      !pinged.has(canonical)
    ) {
      pinged.add(canonical);
      report('may_ping', PING_COPY[ping](token.raw), token.span);
    }
  }

  return found;
}

export function validateConfigTemplates(
  templates: ModuleTemplates,
  next: unknown,
  before?: unknown,
): TemplateReport {
  const previous = new Map<string, string>();

  if (before !== undefined) {
    for (const site of templates.collect(before)) {
      if (!previous.has(site.path)) previous.set(site.path, site.text);
    }
  }

  const byPath = new Map<string, SurfaceDiagnostic[]>();
  const blocking: TemplateIssue[] = [];

  for (const site of templates.collect(next)) {
    const surface = Object.hasOwn(templates.surfaces, site.surfaceId)
      ? templates.surfaces[site.surfaceId]
      : undefined;
    if (surface === undefined) continue;

    const prior = previous.get(site.path);
    const changed = prior !== site.text;
    const result = validateTemplate(site.text, {
      registry: surface.registry,
      field: site.spec.kind,
      event: surface.event,
      audience: surface.audience,
    });

    const found: SurfaceDiagnostic[] = [];

    for (const raw of result.diagnostics) {
      const diagnostic = withSuggestion(raw, surface, result.tokens);
      found.push(diagnostic);

      if (changed && diagnostic.severity === 'error') {
        blocking.push({ path: site.path, label: site.spec.label, diagnostic });
      }
    }

    found.push(...surfaceDiagnostics(site, surface, result.tokens, prior));
    byPath.set(site.path, [...(byPath.get(site.path) ?? []), ...found]);
  }

  return { byPath, blocking };
}

function inline(text: string): string {
  return text.replaceAll(';', ',').replace(/[\r\n]+/g, ' ');
}

export function formatTemplateIssues(report: Pick<TemplateReport, 'blocking'>): string {
  return report.blocking
    .map(({ path, label, diagnostic }) => `${path} ${inline(label)}: ${inline(diagnostic.message)}`)
    .join('; ');
}
