import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  createPlaceholderRegistry,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_SEVERITY,
  type DiagnosticCode,
  type DiagnosticSeverity,
  definitionsFor,
  describeType,
  FIELD_LABELS,
  isRestricted,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  MODIFIER_NAMES,
  type ModifierName,
  modifiersFor,
  modifierUsage,
  type PlaceholderDefinition,
  type PlaceholderLookup,
  type PlaceholderRegistry,
  type PlaceholderSurface,
  type PlaceholderType,
  REPLY_ACTION_FIELDS,
  type RenderOptions,
  type ResolvedValue,
  renderTemplate,
  SAMPLE_NOW,
  SCALAR_TYPES,
  SENSITIVITY_LABELS,
  SURFACE_DIAGNOSTIC_CODES,
  SURFACE_DIAGNOSTIC_SEVERITY,
  type SurfaceDiagnosticCode,
  type TemplateField,
  type TemplateFieldSpec,
  placeholderValue as v,
} from '../src/placeholders/index.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');

const MODULES_DIR = join(ROOT, 'packages', 'modules');

const DOC_PATH = join(ROOT, 'docs', 'PLACEHOLDERS.md');

const START = '<!-- placeholders-doc:start -->';

const END = '<!-- placeholders-doc:end -->';

const COMMAND = 'bun packages/core/scripts/placeholders-doc.ts';

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

type Surface = PlaceholderSurface<unknown>;

interface ModuleSurfaces {
  module: string;
  surfaces: Surface[];
}

const packageSchema = z.object({ exports: z.record(z.string(), z.unknown()).optional() });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSurface(value: unknown): value is Surface {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.module === 'string' &&
    Array.isArray(value.fields) &&
    Array.isArray(value.samples) &&
    typeof value.build === 'function' &&
    typeof value.pickerFor === 'function'
  );
}

function surfacesOf(exported: Record<string, unknown>): Surface[] {
  const found = new Map<string, Surface>();
  const values = Object.values(exported);

  for (const value of values) {
    if (!isRecord(value) || !isRecord(value.surfaces) || typeof value.collect !== 'function') {
      continue;
    }
    for (const surface of Object.values(value.surfaces)) {
      if (isSurface(surface) && !found.has(surface.id)) found.set(surface.id, surface);
    }
  }

  for (const value of values) {
    if (isSurface(value) && !found.has(value.id)) found.set(value.id, value);
  }

  return [...found.values()];
}

async function placeholdersIn(dir: string): Promise<Surface[]> {
  const manifest = packageSchema.parse(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
  const target = manifest.exports?.['./placeholders'];
  if (typeof target !== 'string') return [];

  // By file through the package's export map: @proton/core cannot depend on the module packages.
  const exported: Record<string, unknown> = await import(pathToFileURL(join(dir, target)).href);
  return surfacesOf(exported);
}

async function loadModules(): Promise<ModuleSurfaces[]> {
  const dirs = readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(MODULES_DIR, entry.name))
    .filter((dir) => existsSync(join(dir, 'package.json')));

  const byModule = new Map<string, Surface[]>();

  for (const surface of (await Promise.all(dirs.map(placeholdersIn))).flat()) {
    const list = byModule.get(surface.module) ?? [];
    list.push(surface);
    byModule.set(surface.module, list);
  }

  return [...byModule]
    .map(([module, surfaces]) => ({ module, surfaces }))
    .sort((a, b) => a.module.localeCompare(b.module, 'en'));
}

// ICU puts a narrow no-break space before AM and PM on some machines only, so --check would flap.
function cell(text: string): string {
  return text
    .replace(/[  ]/g, ' ')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replaceAll('|', '\\|')
    .trim();
}

function code(text: string): string {
  const flat = cell(text);
  if (flat === '') return '';
  return flat.includes('`') ? flat : `\`${flat}\``;
}

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function prunedTable(
  head: readonly string[],
  rows: readonly (readonly string[])[],
  optional: readonly number[],
): string {
  const dropped = new Set(optional.filter((index) => rows.every((row) => row[index] === '')));
  const keep = (row: readonly string[]) => row.filter((_, index) => !dropped.has(index));
  return table(keep(head), rows.map(keep));
}

function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function withoutArticle(text: string): string {
  return text.replace(/^an? /, '');
}

function typeName(type: PlaceholderType): string {
  const item = SCALAR_TYPES.find((scalar) => type === `list<${scalar}>`);
  return item === undefined
    ? withoutArticle(describeType(type))
    : `list of ${withoutArticle(describeType(item))}s`;
}

function kindName(kind: TemplateField): string {
  return withoutArticle(FIELD_LABELS[kind]);
}

function token(key: string): string {
  return `{${key}}`;
}

function kindsOf(surface: Surface): TemplateField[] {
  return [...new Set(surface.fields.map(({ kind }) => kind))];
}

function headingOf(surface: Surface): string {
  return `${surface.label} (\`${surface.id}\`)`;
}

function surfaceLink(surface: Surface): string {
  return `[${surface.label}](#${slug(headingOf(surface))})`;
}

interface FieldSet {
  name: string;
  fields: readonly TemplateFieldSpec[];
}

const FIELD_SETS: readonly FieldSet[] = [
  { name: 'every [message field](#message-fields)', fields: MESSAGE_TEMPLATE_FIELDS },
  {
    name: 'every layout field (the `v2` rows of the [message fields](#message-fields))',
    fields: MESSAGE_TEMPLATE_FIELDS.filter(({ path }) => path.startsWith('v2.')),
  },
  {
    name: 'the reply text of buttons and dropdown options (see [message fields](#message-fields))',
    fields: REPLY_ACTION_FIELDS,
  },
];

function joinedPath(prefix: string, path: string): string {
  return prefix === '' ? path : `${prefix}.${path}`;
}

function prefixOf(path: string, suffix: string): string | undefined {
  if (path === suffix) return '';
  return path.endsWith(`.${suffix}`) ? path.slice(0, -(suffix.length + 1)) : undefined;
}

function fieldLines(surface: Surface): string[] {
  let remaining = [...surface.fields];
  const lines: string[] = [];

  for (const set of FIELD_SETS) {
    const [first] = set.fields;
    if (first === undefined) continue;

    const prefixes = remaining.flatMap((spec) => {
      const prefix = spec.kind === first.kind ? prefixOf(spec.path, first.path) : undefined;
      return prefix === undefined ? [] : [prefix];
    });

    for (const prefix of prefixes) {
      const matched = set.fields.flatMap((member) => {
        const spec = remaining.find(
          (candidate) =>
            candidate.path === joinedPath(prefix, member.path) && candidate.kind === member.kind,
        );
        return spec === undefined ? [] : [spec];
      });
      if (matched.length !== set.fields.length) continue;

      remaining = remaining.filter((spec) => !matched.includes(spec));
      const where = prefix === '' ? 'at the top of the settings' : `under \`${prefix}\``;
      lines.push(`Fields: ${set.name}, ${where}.`);
    }
  }

  if (remaining.length > 0) {
    lines.push(
      lines.length === 0 ? 'Fields:' : 'Other fields:',
      '',
      table(
        ['Setting', 'Label', 'Kind', 'Limit'],
        remaining.map((spec) => [
          code(spec.path),
          cell(spec.label),
          kindName(spec.kind),
          spec.limit === undefined ? '' : String(spec.limit),
        ]),
      ),
    );
  }

  return lines;
}

function offeredByKind(surface: Surface): Map<TemplateField, ReadonlySet<PlaceholderDefinition>> {
  return new Map(
    kindsOf(surface).map(
      (field) =>
        [
          field,
          new Set(
            definitionsFor(surface.registry, {
              field,
              event: surface.event,
              audience: surface.audience,
            }),
          ),
        ] as const,
    ),
  );
}

function exampleOf(
  surface: Surface,
  definition: PlaceholderDefinition,
  sample: PlaceholderLookup | undefined,
): string {
  const key = definition.key.replace(/<([a-z][a-z0-9_]*)>/g, '$1');
  const options: RenderOptions = {
    registry: surface.registry,
    field: 'plain_text',
    event: surface.event,
    audience: surface.audience,
    now: SAMPLE_NOW,
  };

  if (sample !== undefined && key === definition.key) {
    const shown = renderTemplate(token(key), sample, options).output;
    if (shown !== '') return shown;
  }

  return renderTemplate(token(key), () => definition.example, options).output;
}

function refusal(
  surface: Surface,
  definition: PlaceholderDefinition,
  labels: ReadonlyMap<string, string>,
): string {
  const { events } = definition.availability;

  if (events !== undefined && !events.includes(surface.event)) {
    const where = events.flatMap((event) => {
      const label = labels.get(event);
      return label === undefined ? [] : [label];
    });
    return where.length === 0
      ? 'Not filled in anywhere, on purpose.'
      : `Only filled in on: ${where.join(', ')}.`;
  }

  if (isRestricted(definition, surface.audience)) {
    return `Private to ${SENSITIVITY_LABELS[definition.sensitivity]}, and this is seen by ${SENSITIVITY_LABELS[surface.audience]}.`;
  }

  return `Cannot go in ${kindsOf(surface)
    .map((kind) => FIELD_LABELS[kind])
    .join(' or ')}.`;
}

function surfaceSection(surface: Surface, labels: ReadonlyMap<string, string>): string {
  const offered = offeredByKind(surface);
  const kinds = kindsOf(surface);
  const [sample] = surface.samples;
  const lookup =
    sample === undefined ? undefined : surface.build(sample.facts, { now: SAMPLE_NOW });
  const rows: string[][] = [];
  const refused: string[][] = [];

  for (const definition of surface.definitions) {
    const missing = kinds.filter((kind) => offered.get(kind)?.has(definition) !== true);

    if (missing.length === kinds.length) {
      refused.push([
        code(token(definition.key)),
        cell(definition.label),
        cell(refusal(surface, definition, labels)),
      ]);
      continue;
    }

    rows.push([
      code(token(definition.key)),
      cell(definition.label),
      cell(definition.group),
      typeName(definition.type),
      definition.aliases.map((alias) => code(token(alias))).join(' '),
      missing.map(kindName).join(', '),
      code(exampleOf(surface, definition, lookup)),
      cell(definition.description),
    ]);
  }

  const parts = [
    `##### ${headingOf(surface)}`,
    '',
    `Seen by ${SENSITIVITY_LABELS[surface.audience]}. ${
      sample === undefined
        ? 'It has no sample, so each example is the placeholder’s own.'
        : `Examples come from “${cell(sample.label)}”, or from the placeholder’s own example where that sample has no value.`
    }`,
    '',
    ...fieldLines(surface),
    '',
    prunedTable(
      [
        'Placeholder',
        'Label',
        'Group',
        'Type',
        'Older name',
        'Not offered in',
        'Example',
        'Description',
      ],
      rows,
      [4, 5],
    ),
  ];

  if (refused.length > 0) {
    parts.push(
      '',
      'Registered here only so that using them is refused when you save, instead of being posted as written:',
      '',
      table(['Placeholder', 'Label', 'Why it is refused'], refused),
    );
  }

  return parts.join('\n');
}

function indexSection(modules: readonly ModuleSurfaces[]): string {
  const rows = modules.flatMap(({ module, surfaces }) =>
    surfaces.map((surface) => {
      const offered = new Set(
        kindsOf(surface).flatMap((field) =>
          definitionsFor(surface.registry, {
            field,
            event: surface.event,
            audience: surface.audience,
          }),
        ),
      );
      return [
        code(module),
        surfaceLink(surface),
        code(surface.id),
        SENSITIVITY_LABELS[surface.audience],
        String(offered.size),
        String(surface.definitions.length - offered.size),
      ];
    }),
  );

  return table(['Module', 'Surface', 'Id', 'Seen by', 'Offered', 'Refused'], rows);
}

function messageFieldsSection(): string {
  const rows = (fields: readonly TemplateFieldSpec[]) =>
    fields.map((spec) => [
      code(spec.path),
      cell(spec.label),
      kindName(spec.kind),
      spec.limit === undefined ? '' : String(spec.limit),
    ]);

  return [
    table(['Path in the message', 'Label', 'Kind', 'Limit'], rows(MESSAGE_TEMPLATE_FIELDS)),
    '',
    'Reply actions, filled in only on Messages templates with placeholders switched on:',
    '',
    table(['Path in the message', 'Label', 'Kind', 'Limit'], rows(REPLY_ACTION_FIELDS)),
  ].join('\n');
}

const EXAMPLE_VALUES: Readonly<Record<string, ResolvedValue>> = {
  'server.member_count': v.integer(1204),
  'level.rank': v.integer(12),
  'xp.progress_percent': v.percent(66.86),
  'server.name': v.text('Proton HQ'),
  'user.display_name': v.text('Fraimer the Magnificent'),
  'ticket.type_name': v.text('Billing Help'),
  'user.joined_at': v.datetime(SAMPLE_NOW - 3 * DAY),
  now: v.datetime(SAMPLE_NOW),
  'event.created_at': v.datetime(SAMPLE_NOW),
  'user.account_age': v.duration(2 * HOUR + 5 * MINUTE),
  'user.nickname': v.notSet(),
  'user.role_mentions': v.list('mention', [
    v.role('100000000000000020', 'Mods'),
    v.role('100000000000000021', 'Level 5'),
    v.role('100000000000000022', 'Helpers'),
  ]),
  'user.is_boosting': v.boolean(true),
};

const MODIFIER_EXAMPLES: Readonly<Record<ModifierName, string>> = {
  number: '{server.member_count:number}',
  compact: '{server.member_count:compact}',
  ordinal: '{level.rank:ordinal}',
  percent: '{xp.progress_percent:percent}',
  upper: '{server.name:upper}',
  lower: '{server.name:lower}',
  truncate: '{user.display_name:truncate(8)}',
  slug: '{ticket.type_name:slug}',
  relative: '{user.joined_at:relative}',
  full: '{now:full}',
  date: '{now:date}',
  time: '{now:time}',
  unix: '{event.created_at:unix}',
  duration: '{user.account_age:duration}',
  fallback: '{user.nickname:fallback("no nickname")}',
  join: '{user.role_mentions:join(" / ")}',
  limit: '{user.role_mentions:limit(2)}',
  count: '{user.role_mentions:count}',
  label: '{user.is_boosting:label("Booster","Member")}',
};

const PROBE_TYPES: readonly PlaceholderType[] = [...SCALAR_TYPES, 'list<text>'];

function exampleRegistry(surfaces: readonly Surface[]): PlaceholderRegistry {
  const byKey = new Map<string, PlaceholderDefinition>();

  for (const surface of surfaces) {
    for (const definition of surface.definitions) {
      if (!byKey.has(definition.key)) byKey.set(definition.key, definition);
    }
  }

  return createPlaceholderRegistry(
    Object.keys(EXAMPLE_VALUES).map((key) => {
      const definition = byKey.get(key);
      if (definition === undefined) {
        throw new Error(`no placeholder surface defines {${key}}, which a modifier example uses`);
      }
      return { ...definition, aliases: [], availability: {}, sensitivity: 'public' as const };
    }),
  );
}

function renderExample(template: string, registry: PlaceholderRegistry, field: TemplateField) {
  const result = renderTemplate(template, lookupFrom(EXAMPLE_VALUES), {
    registry,
    field,
    now: SAMPLE_NOW,
  });
  const problems = result.diagnostics.filter(({ severity }) => severity === 'error');

  if (problems.length > 0 || result.unknown.length > 0) {
    const detail = problems.map(({ message }) => message).join(' ');
    throw new Error(`the modifier example ${template} does not render: ${detail}`);
  }

  return result.output;
}

function worksOn(name: ModifierName): string {
  const accepted = PROBE_TYPES.filter((type) => modifiersFor(type, 'plain_text').includes(name));
  if (accepted.length === PROBE_TYPES.length) return 'anything';

  return accepted
    .map((type) => (type.startsWith('list<') ? 'lists' : withoutArticle(describeType(type))))
    .join(', ');
}

function modifierSection(surfaces: readonly Surface[]): string {
  const registry = exampleRegistry(surfaces);

  return table(
    [
      'Modifier',
      'Written as',
      'Works on',
      'In links',
      'Example',
      'In plain text',
      'In message text',
    ],
    MODIFIER_NAMES.map((name) => {
      const example = MODIFIER_EXAMPLES[name];
      const inLinks = PROBE_TYPES.some((type) => modifiersFor(type, 'url').includes(name));

      return [
        code(`:${name}`),
        code(modifierUsage(name)),
        worksOn(name),
        inLinks ? 'yes' : 'no',
        code(example),
        code(renderExample(example, registry, 'plain_text')),
        code(renderExample(example, registry, 'discord_text')),
      ];
    }),
  );
}

type NoteCode = DiagnosticCode | SurfaceDiagnosticCode;

type NoteWhen = 'editing' | 'posting' | 'both';

const SEVERITY: Readonly<Record<NoteCode, DiagnosticSeverity>> = {
  ...DIAGNOSTIC_SEVERITY,
  ...SURFACE_DIAGNOSTIC_SEVERITY,
};

const NOTES: Readonly<Record<NoteCode, readonly [when: NoteWhen, meaning: string]>> = {
  template_too_long: [
    'editing',
    'The text is longer than 6,000 characters, so nothing in it is filled in.',
  ],
  too_many_placeholders: [
    'editing',
    'The text has more than 100 placeholders. The ones after the 100th are posted as written.',
  ],
  too_many_modifiers: [
    'editing',
    'A placeholder has more than 4 modifiers, so it is posted as written.',
  ],
  too_many_arguments: [
    'editing',
    'A modifier is given more than 4 arguments, so the placeholder is posted as written.',
  ],
  argument_too_long: [
    'editing',
    'A modifier argument is longer than 200 characters, so the placeholder is posted as written.',
  ],
  key_too_long: [
    'editing',
    'A placeholder name is longer than 200 characters, so it is posted as written.',
  ],
  lone_brace: [
    'editing',
    'A { or } that is not part of a placeholder, often because of a space inside the braces. It is posted as written.',
  ],
  malformed_placeholder: [
    'editing',
    'A placeholder that is started but not finished: a missing }, ) or closing quote, or a space between arguments. It is posted as written.',
  ],
  forbidden_key: [
    'editing',
    'A reserved name: one that starts with _, or is constructor or prototype. It is posted as written.',
  ],
  unknown_placeholder: [
    'editing',
    'Not a placeholder for this message. It is posted as written, and the note suggests a close name when there is one.',
  ],
  unavailable: [
    'editing',
    'This message never knows that value, so it is left empty, or shows its fallback.',
  ],
  restricted: [
    'editing',
    'The value is private to someone who does not see this message, so it is left empty, or shows its fallback.',
  ],
  incompatible_field: [
    'editing',
    'The value cannot go in this field, such as a mention in a link, so it is left empty, or shows its fallback.',
  ],
  unknown_modifier: ['editing', 'Not a modifier. It is ignored.'],
  incompatible_modifier: [
    'editing',
    'The modifier does not work on this value or in this field, or a second :fallback was given. It is ignored.',
  ],
  invalid_argument: ['editing', 'A modifier is given the wrong arguments. It is ignored.'],
  invalid_value: [
    'posting',
    'Proton was handed a value of the wrong kind. It is left empty, or shows its fallback.',
  ],
  resolver_failed: [
    'posting',
    'Proton could not read the value, for example because a profile lookup failed. It is left empty, or shows its fallback.',
  ],
  not_set: [
    'posting',
    'There is no value, such as a member with no nickname. It is left empty, or shows its fallback.',
  ],
  list_truncated: ['posting', 'A list has more than 50 items. Only the first 50 are shown.'],
  output_truncated: ['posting', 'The filled-in text passed a length limit, so the end was cut.'],
  invalid_url: [
    'both',
    'A link does not start with http:// or https://, or does not come out as one once filled in, so it is left empty.',
  ],
  empty_channel_name: ['posting', 'A channel name comes out empty once filled in.'],
  mention_without_name: [
    'posting',
    'A mention with no readable name, in a field that cannot show mentions. It is left empty.',
  ],
  invalid_locale: [
    'posting',
    'Proton was given a language it does not know, so dates and numbers are written in US English. Nothing in the dashboard causes this.',
  ],
  invalid_time_zone: [
    'posting',
    'Proton was given a time zone it does not know, so times are written in UTC. Nothing in the dashboard causes this.',
  ],
  may_ping: [
    'editing',
    "The placeholder writes mentions, and this message's mention settings allow those pings, so they will ping.",
  ],
  doubled_brace_literal: ['editing', '{{ or }} was added. Each now writes a single literal brace.'],
  legacy_alias: ['editing', 'An older name. It still works; suggestions insert the current name.'],
  legacy_alias_in_url: [
    'editing',
    'An older name in a link. It is written link-safe, so spaces become %20.',
  ],
  plain_text_value: [
    'editing',
    'This field cannot show mentions or Discord timestamps, so the placeholder shows a name or a readable date instead.',
  ],
};

const SHOWN: Readonly<Record<NoteWhen, string>> = {
  editing: 'while editing',
  posting: 'when posting, and in previews',
  both: 'while editing and when posting',
};

const KIND_OF_NOTE: Readonly<Record<DiagnosticSeverity, string>> = {
  error: 'problem',
  warning: 'warning',
  info: 'note',
};

function notesSection(): string {
  const codes: readonly NoteCode[] = [...DIAGNOSTIC_CODES, ...SURFACE_DIAGNOSTIC_CODES];

  return table(
    ['Code', 'Kind', 'Shown', 'Blocks saving', 'Meaning'],
    codes.map((name) => {
      if (!Object.hasOwn(NOTES, name)) throw new Error(`the note ${name} has no meaning written`);

      const [when, meaning] = NOTES[name];
      const severity = SEVERITY[name];
      const blocks = severity === 'error' && when !== 'posting';

      return [
        code(name),
        KIND_OF_NOTE[severity],
        SHOWN[when],
        blocks ? 'yes, when that text changed' : 'no',
        cell(meaning),
      ];
    }),
  );
}

function olderNamesSection(surfaces: readonly Surface[]): string {
  const rows = surfaces.flatMap((surface) =>
    surface.definitions.flatMap((definition) =>
      definition.aliases.map((alias) => [
        surfaceLink(surface),
        code(token(alias)),
        code(token(definition.key)),
      ]),
    ),
  );

  return table(['Surface', 'Older name', 'Current name'], rows);
}

async function generate(): Promise<string> {
  const modules = await loadModules();
  const surfaces = modules.flatMap((entry) => entry.surfaces);
  const labels = new Map(surfaces.map((surface) => [surface.event, surface.label]));

  return [
    `_Generated from the placeholder registries by \`${COMMAND} --write\`. Do not edit between the markers by hand._`,
    '',
    '### Surfaces',
    '',
    indexSection(modules),
    '',
    '### Message fields',
    '',
    messageFieldsSection(),
    '',
    '### Modifier reference',
    '',
    modifierSection(surfaces),
    '',
    '### Editor notes',
    '',
    notesSection(),
    '',
    '### Older names by surface',
    '',
    olderNamesSection(surfaces),
    '',
    '### Placeholders by surface',
    ...modules.flatMap(({ module, surfaces: own }) => [
      '',
      `#### Module \`${module}\``,
      ...own.flatMap((surface) => ['', surfaceSection(surface, labels)]),
    ]),
  ].join('\n');
}

function withGenerated(doc: string, generated: string): string {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);

  if (start === -1 || end < start) {
    throw new Error(`${DOC_PATH} has no ${START} … ${END} block to fill in`);
  }

  return `${doc.slice(0, start + START.length)}\n\n${generated}\n\n${doc.slice(end)}`;
}

if (import.meta.main) {
  const [option] = process.argv.slice(2);
  const generated = await generate();

  if (option === undefined) {
    process.stdout.write(`${generated}\n`);
  } else if (option === '--write' || option === '--check') {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const next = withGenerated(doc, generated);

    if (option === '--write') {
      writeFileSync(DOC_PATH, next, 'utf8');
      console.log(`wrote the placeholder reference into ${DOC_PATH}`);
    } else if (next === doc) {
      console.log(`${DOC_PATH} is up to date`);
    } else {
      console.error(`${DOC_PATH} is out of date: run ${COMMAND} --write`);
      process.exitCode = 1;
    }
  } else {
    throw new Error(
      `unknown option ${option}: pass --write to update ${DOC_PATH}, --check to verify it, or nothing to print`,
    );
  }
}
