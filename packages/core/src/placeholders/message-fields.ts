import type { ActionRow, MessageButton } from '../messages/components.ts';
import type { Embed } from '../messages/embed.ts';
import type { ContainerChild, V2Component } from '../messages/v2.ts';
import { DIAGNOSTIC_SEVERITY, type TemplateDiagnostic } from './diagnostics.ts';
import { DISCORD_TEXT_LIMITS, enforceMessageLimits } from './discord-limits.ts';
import { parseTemplate } from './grammar.ts';
import { URL_MAX } from './limits.ts';
import { type PlaceholderLookup, renderTemplate } from './render.ts';
import type { PlaceholderSurface, TemplateFieldSpec } from './surface.ts';

export interface ProtonMessageLike {
  content?: string | undefined;
  embeds: Embed[];
  components: ActionRow[];
  v2?: V2Component[] | undefined;
}

export interface MentionSettings {
  everyone: boolean;
  roles: boolean;
  users: boolean;
}

export interface PathDiagnostic extends TemplateDiagnostic {
  path: string;
}

export type MessageRender<M> =
  | { ok: true; message: M; diagnostics: PathDiagnostic[] }
  | { ok: false; humanReason: string; diagnostics: PathDiagnostic[] };

export interface MessageRenderOptions {
  now: number;
  locale?: string | undefined;
  timeZone?: string | undefined;
  basePath?: string | undefined;
}

export interface MessageSite {
  path: string;
  spec: TemplateFieldSpec;
  text: string;
  mentions: MentionSettings;
}

const LIMITS = DISCORD_TEXT_LIMITS;

function v2Fields(prefix: string): TemplateFieldSpec[] {
  return [
    { path: `${prefix}.content`, kind: 'discord_text', label: 'Text', limit: LIMITS.textDisplay },
    {
      path: `${prefix}.text.*`,
      kind: 'discord_text',
      label: 'Section line',
      limit: LIMITS.textDisplay,
    },
    { path: `${prefix}.accessory.url`, kind: 'url', label: 'Section image' },
    {
      path: `${prefix}.accessory.description`,
      kind: 'plain_text',
      label: 'Section image description',
      limit: LIMITS.mediaDescription,
    },
    {
      path: `${prefix}.accessory.button.label`,
      kind: 'plain_text',
      label: 'Section button label',
      limit: LIMITS.buttonLabel,
    },
    {
      path: `${prefix}.accessory.button.url`,
      kind: 'url',
      label: 'Section button link',
      limit: LIMITS.buttonUrl,
    },
    { path: `${prefix}.items.*.url`, kind: 'url', label: 'Image' },
    {
      path: `${prefix}.items.*.description`,
      kind: 'plain_text',
      label: 'Image description',
      limit: LIMITS.mediaDescription,
    },
    {
      path: `${prefix}.row.buttons.*.label`,
      kind: 'plain_text',
      label: 'Button label',
      limit: LIMITS.buttonLabel,
    },
    {
      path: `${prefix}.row.buttons.*.url`,
      kind: 'url',
      label: 'Button link',
      limit: LIMITS.buttonUrl,
    },
  ];
}

const FIELDS: TemplateFieldSpec[] = [
  { path: 'content', kind: 'discord_text', label: 'Message text', limit: LIMITS.content },
  { path: 'embeds.*.title', kind: 'discord_text', label: 'Embed title', limit: LIMITS.embedTitle },
  {
    path: 'embeds.*.description',
    kind: 'discord_text',
    label: 'Embed description',
    limit: LIMITS.embedDescription,
  },
  { path: 'embeds.*.url', kind: 'url', label: 'Embed title link', limit: URL_MAX },
  {
    path: 'embeds.*.author.name',
    kind: 'plain_text',
    label: 'Embed author',
    limit: LIMITS.embedAuthor,
  },
  { path: 'embeds.*.author.url', kind: 'url', label: 'Embed author link', limit: URL_MAX },
  { path: 'embeds.*.author.iconUrl', kind: 'url', label: 'Embed author icon', limit: URL_MAX },
  { path: 'embeds.*.footer.iconUrl', kind: 'url', label: 'Embed footer icon', limit: URL_MAX },
  { path: 'embeds.*.imageUrl', kind: 'url', label: 'Embed image', limit: URL_MAX },
  { path: 'embeds.*.thumbnailUrl', kind: 'url', label: 'Embed thumbnail', limit: URL_MAX },
  {
    path: 'embeds.*.footer.text',
    kind: 'plain_text',
    label: 'Embed footer',
    limit: LIMITS.embedFooter,
  },
  {
    path: 'embeds.*.fields.*.name',
    kind: 'discord_text',
    label: 'Embed field name',
    limit: LIMITS.embedFieldName,
  },
  {
    path: 'embeds.*.fields.*.value',
    kind: 'discord_text',
    label: 'Embed field text',
    limit: LIMITS.embedFieldValue,
  },
  {
    path: 'components.*.buttons.*.label',
    kind: 'plain_text',
    label: 'Button label',
    limit: LIMITS.buttonLabel,
  },
  {
    path: 'components.*.buttons.*.url',
    kind: 'url',
    label: 'Button link',
    limit: LIMITS.buttonUrl,
  },
  {
    path: 'components.*.select.placeholder',
    kind: 'plain_text',
    label: 'Dropdown placeholder',
    limit: LIMITS.selectPlaceholder,
  },
  {
    path: 'components.*.select.options.*.label',
    kind: 'plain_text',
    label: 'Dropdown option label',
    limit: LIMITS.selectOptionLabel,
  },
  {
    path: 'components.*.select.options.*.description',
    kind: 'plain_text',
    label: 'Dropdown option description',
    limit: LIMITS.selectOptionDescription,
  },
  ...v2Fields('v2.*'),
  ...v2Fields('v2.*.children.*'),
];

export const MESSAGE_TEMPLATE_FIELDS: readonly TemplateFieldSpec[] = Object.freeze(FIELDS);

const REPLY_FIELDS: TemplateFieldSpec[] = [
  {
    path: 'components.*.buttons.*.action.content',
    kind: 'discord_text',
    label: 'Reply text',
    limit: LIMITS.content,
  },
  {
    path: 'components.*.select.options.*.action.content',
    kind: 'discord_text',
    label: 'Reply text',
    limit: LIMITS.content,
  },
];

export const REPLY_ACTION_FIELDS: readonly TemplateFieldSpec[] = Object.freeze(REPLY_FIELDS);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

export interface FoundSite {
  segments: readonly string[];
  text: string;
  ancestors: readonly unknown[];
  write(next: string | undefined): void;
}

function walk(
  node: unknown,
  pattern: readonly string[],
  depth: number,
  at: readonly string[],
  ancestors: readonly unknown[],
  found: (site: FoundSite) => void,
): void {
  const segment = pattern[depth];
  if (segment === undefined) return;

  const last = depth === pattern.length - 1;
  const descend = (child: unknown, key: string, write: (next: string | undefined) => void) => {
    const segments = [...at, key];
    const chain = [...ancestors, node];

    if (!last) {
      walk(child, pattern, depth + 1, segments, chain, found);
    } else if (typeof child === 'string') {
      found({ segments, text: child, ancestors: chain, write });
    }
  };

  if (segment === '*') {
    if (!Array.isArray(node)) return;

    const items: unknown[] = node;
    for (const [index, item] of items.entries()) {
      descend(item, String(index), (next) => {
        items[index] = next ?? '';
      });
    }
    return;
  }

  if (!isRecord(node) || !Object.hasOwn(node, segment)) return;

  descend(node[segment], segment, (next) => {
    if (next === undefined) Reflect.deleteProperty(node, segment);
    else node[segment] = next;
  });
}

export function visitTemplatePaths(
  root: unknown,
  path: string,
  found: (site: FoundSite) => void,
): void {
  walk(root, path.split('.'), 0, [], [], found);
}

export function isMessageLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    (isRecord(own(value, 'mentions')) ||
      Array.isArray(own(value, 'embeds')) ||
      Array.isArray(own(value, 'components')) ||
      Array.isArray(own(value, 'v2')))
  );
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function mentionSettingsOf(message: unknown): MentionSettings {
  const stored = isRecord(message) ? own(message, 'mentions') : undefined;
  const policy = isRecord(stored) ? stored : {};

  return {
    everyone: flag(own(policy, 'everyone'), false),
    roles: flag(own(policy, 'roles'), true),
    users: flag(own(policy, 'users'), true),
  };
}

export function joinPath(basePath: string, path: string): string {
  if (basePath === '') return path;
  return path === '' ? basePath : `${basePath}.${path}`;
}

export function collectMessageSites(
  message: unknown,
  basePath: string,
  fields: readonly TemplateFieldSpec[] = MESSAGE_TEMPLATE_FIELDS,
): MessageSite[] {
  const mentions = mentionSettingsOf(message);
  const sites: MessageSite[] = [];

  for (const spec of fields) {
    visitTemplatePaths(message, spec.path, ({ segments, text }) => {
      sites.push({ path: joinPath(basePath, segments.join('.')), spec, text, mentions });
    });
  }

  return sites;
}

const OPTIONAL_LINKS: ReadonlySet<string> = new Set([
  'embeds.*.url',
  'embeds.*.author.url',
  'embeds.*.author.iconUrl',
  'embeds.*.footer.iconUrl',
  'embeds.*.imageUrl',
  'embeds.*.thumbnailUrl',
]);

interface Problem {
  path: string;
  label: string;
  reason: string;
}

const FILLED = 'once its placeholders are filled in';

function blank(text: string | undefined): boolean {
  return text === undefined || text.trim() === '';
}

function isLink(url: string): boolean {
  return /^https?:\/\//i.test(url) && URL.canParse(url);
}

function isBlankEmbed(embed: Embed): boolean {
  return (
    blank(embed.title) &&
    blank(embed.description) &&
    blank(embed.footer?.text) &&
    blank(embed.author?.name) &&
    blank(embed.imageUrl) &&
    blank(embed.thumbnailUrl) &&
    (embed.fields ?? []).length === 0
  );
}

function buttonProblems(button: MessageButton, base: string, problems: Problem[]): void {
  if (blank(button.label) && button.emoji === undefined) {
    problems.push({
      path: `${base}.label`,
      label: 'Button label',
      reason: `is empty ${FILLED}, and a button needs a label or an emoji`,
    });
  }

  if (button.style === 'link' && !isLink(button.url ?? '')) {
    problems.push({
      path: `${base}.url`,
      label: 'Button link',
      reason: `is not an http or https address ${FILLED}, and a link button needs one`,
    });
  }
}

function rowProblems(row: ActionRow, base: string, problems: Problem[]): void {
  if (row.kind === 'buttons') {
    for (const [index, button] of row.buttons.entries()) {
      buttonProblems(button, `${base}.buttons.${index}`, problems);
    }
    return;
  }

  for (const [index, option] of row.select.options.entries()) {
    if (!blank(option.label)) continue;
    problems.push({
      path: `${base}.select.options.${index}.label`,
      label: 'Dropdown option label',
      reason: `is empty ${FILLED}, and Discord refuses an option without a label`,
    });
  }
}

function childProblems(child: ContainerChild, base: string, problems: Problem[]): void {
  switch (child.kind) {
    case 'text':
      if (blank(child.content)) {
        problems.push({
          path: `${base}.content`,
          label: 'Text',
          reason: `is empty ${FILLED}, and Discord refuses an empty text display`,
        });
      }
      return;
    case 'section':
      for (const [index, line] of child.text.entries()) {
        if (!blank(line)) continue;
        problems.push({
          path: `${base}.text.${index}`,
          label: 'Section line',
          reason: `is empty ${FILLED}, and Discord refuses an empty section line`,
        });
      }
      if (child.accessory.kind === 'button') {
        buttonProblems(child.accessory.button, `${base}.accessory.button`, problems);
      } else if (!isLink(child.accessory.url.trim())) {
        problems.push({
          path: `${base}.accessory.url`,
          label: 'Section image',
          reason: `is not an http or https address ${FILLED}, and a section image needs one`,
        });
      }
      return;
    case 'gallery':
      for (const [index, item] of child.items.entries()) {
        if (isLink(item.url.trim())) continue;
        problems.push({
          path: `${base}.items.${index}.url`,
          label: 'Image',
          reason: `is not an http or https address ${FILLED}, and a gallery image needs one`,
        });
      }
      return;
    case 'row':
      rowProblems(child.row, `${base}.row`, problems);
      return;
    case 'separator':
      return;
  }
}

function structuralProblems(message: ProtonMessageLike): Problem[] {
  const problems: Problem[] = [];
  const links = new Map<string, number>();

  for (const [index, embed] of message.embeds.entries()) {
    const base = `embeds.${index}`;

    for (const [at, field] of (embed.fields ?? []).entries()) {
      if (blank(field.name)) {
        problems.push({
          path: `${base}.fields.${at}.name`,
          label: 'Embed field name',
          reason: `is empty ${FILLED}, and Discord refuses an embed field without a name`,
        });
      }
      if (blank(field.value)) {
        problems.push({
          path: `${base}.fields.${at}.value`,
          label: 'Embed field text',
          reason: `is empty ${FILLED}, and Discord refuses an embed field without text`,
        });
      }
    }

    if (isBlankEmbed(embed)) {
      problems.push({
        path: base,
        label: 'Embed',
        reason: `has nothing in it ${FILLED}, and Discord refuses an empty embed`,
      });
    }

    if (embed.url === undefined || embed.url === '') continue;
    const first = links.get(embed.url);
    if (first === undefined) {
      links.set(embed.url, index);
    } else {
      problems.push({
        path: `${base}.url`,
        label: 'Embed title link',
        reason: `is the same link as embed ${first + 1} ${FILLED}, and Discord shows only the first embed of any one link`,
      });
    }
  }

  for (const [index, row] of message.components.entries()) {
    rowProblems(row, `components.${index}`, problems);
  }

  for (const [index, component] of (message.v2 ?? []).entries()) {
    if (component.kind !== 'container') {
      childProblems(component, `v2.${index}`, problems);
      continue;
    }
    for (const [at, child] of component.children.entries()) {
      childProblems(child, `v2.${index}.children.${at}`, problems);
    }
  }

  return problems;
}

type RenderSurface = Pick<PlaceholderSurface<unknown>, 'registry' | 'event' | 'audience'>;

export function renderMessageTemplate<M extends ProtonMessageLike>(
  message: M,
  surface: RenderSurface,
  lookup: PlaceholderLookup,
  options: MessageRenderOptions,
): MessageRender<M> {
  const basePath = options.basePath ?? '';
  const draft = structuredClone(message);
  const diagnostics: PathDiagnostic[] = [];
  const tokens = new Map<string, readonly string[]>();
  const problems = new Map<string, Problem>();

  for (const spec of MESSAGE_TEMPLATE_FIELDS) {
    visitTemplatePaths(draft, spec.path, ({ segments, text, write }) => {
      const path = segments.join('.');
      const parsed = parseTemplate(text, surface.registry);
      const result = renderTemplate(parsed, lookup, {
        registry: surface.registry,
        field: spec.kind,
        channel: spec.channel,
        event: surface.event,
        audience: surface.audience,
        now: options.now,
        locale: options.locale,
        timeZone: options.timeZone,
      });

      tokens.set(
        path,
        parsed.tokens.flatMap((token) => (token.kind === 'placeholder' ? [token.raw] : [])),
      );

      // A link with nothing to fill in was accepted by the stored shape, which is laxer than isHttpUrl.
      const storedLink =
        spec.kind === 'url' &&
        text.trim() !== '' &&
        !text.includes('{{') &&
        !text.includes('}}') &&
        parsed.tokens.every((token) => token.kind === 'text');

      for (const diagnostic of result.diagnostics) {
        if (storedLink && diagnostic.code === 'invalid_url') continue;
        diagnostics.push({ ...diagnostic, path: joinPath(basePath, path) });
      }

      if (storedLink) {
        write(text);
        return;
      }

      const output = spec.finish === undefined ? result.output : spec.finish(result.output);

      if (spec.kind === 'url' && result.diagnostics.some(({ code }) => code === 'invalid_url')) {
        problems.set(path, {
          path,
          label: spec.label,
          reason: `does not come out as an http or https address ${FILLED}`,
        });
      }

      write(
        spec.kind === 'url' && output === '' && OPTIONAL_LINKS.has(spec.path) ? undefined : output,
      );
    });
  }

  const limited = enforceMessageLimits(draft, (path, text, code = 'output_truncated') => {
    diagnostics.push({
      code,
      severity: DIAGNOSTIC_SEVERITY[code],
      message: text,
      span: null,
      path: joinPath(basePath, path),
    });
  });

  for (const problem of structuralProblems(limited)) {
    if (!problems.has(problem.path)) problems.set(problem.path, problem);
  }

  if (problems.size === 0) return { ok: true, message: limited, diagnostics };

  const usedUnder = (path: string): string[] => [
    ...new Set(
      [...tokens]
        .filter(([at]) => at === path || at.startsWith(`${path}.`))
        .flatMap(([, raws]) => raws),
    ),
  ];

  const reasons = [...problems.values()].map(({ path, label, reason }) => {
    const used = usedUnder(path);
    const holds = used.length === 0 ? 'It holds no placeholders.' : `It uses ${used.join(', ')}.`;
    return `${joinPath(basePath, path)} (${label}) ${reason}. ${holds}`;
  });

  return {
    ok: false,
    humanReason: `this message cannot be sent once its placeholders are filled in: ${reasons.join(' ')}`,
    diagnostics,
  };
}
