import {
  clipGraphemes,
  collectMessageSites,
  type PathDiagnostic,
  type PlaceholderLookup,
  type PlaceholderRequest,
  type PlaceholderSurface,
  type ProtonMessageLike,
  type ResolvedValue,
  renderMessageTemplate,
  renderTemplate,
  SAMPLE_BOT,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  type SurfaceSample,
  usedKeys,
} from '@proton/core/placeholders';

export type MentionNames = ReadonlyMap<string, string>;

export interface MessagePreview<M> {
  message: M;
  caption: string;
  diagnostics: PathDiagnostic[];
  problem: string | undefined;
  mentionNames: MentionNames;
  now: number;
}

export interface TextPreview {
  text: string;
  caption: string;
  mentionNames: MentionNames;
  now: number;
}

const YOUR_SERVER_CAPTION = "Sample: your server's name, sample member";

const MENTION_ID = /\d+/;

function coreSampleNames(): Map<string, string> {
  const names = new Map<string, string>();
  const member = SAMPLE_MEMBER.user.globalName ?? SAMPLE_MEMBER.user.username;
  if (member !== null) names.set(SAMPLE_MEMBER.user.id, member);
  if (typeof SAMPLE_BOT.name === 'string') names.set(SAMPLE_BOT.id, SAMPLE_BOT.name);
  return names;
}

export const SAMPLE_MENTION_NAMES: MentionNames = coreSampleNames();

function renamesServer(overrides: unknown): boolean {
  if (typeof overrides !== 'object' || overrides === null || !('server' in overrides)) return false;

  const { server } = overrides;
  return (
    typeof server === 'object' &&
    server !== null &&
    'name' in server &&
    typeof server.name === 'string'
  );
}

export function previewCaption(sample: SurfaceSample<unknown>, overrides?: unknown): string {
  return renamesServer(overrides) ? YOUR_SERVER_CAPTION : sample.label;
}

function factsFor<F>(sample: SurfaceSample<F>, overrides: Partial<F> | undefined): F {
  return overrides === undefined ? sample.facts : { ...sample.facts, ...overrides };
}

function readValue(
  lookup: PlaceholderLookup,
  request: PlaceholderRequest,
): ResolvedValue | undefined {
  try {
    return lookup(request);
  } catch {
    return undefined;
  }
}

function mentionNamesFor<F>(
  surface: PlaceholderSurface<F>,
  lookup: PlaceholderLookup,
  keys: Iterable<string>,
): MentionNames {
  const names = new Map(SAMPLE_MENTION_NAMES);

  for (const key of keys) {
    const resolution = surface.registry.resolve(key);
    if (resolution === undefined) continue;

    const { canonical, definition, params } = resolution;
    const value = readValue(lookup, { key: canonical, canonical, definition, params });
    if (value === undefined) continue;

    for (const item of value.type === 'list' ? value.items : [value]) {
      if (item.type !== 'mention' || item.name === undefined) continue;
      const id = MENTION_ID.exec(item.value)?.[0];
      if (id !== undefined) names.set(id, item.name);
    }
  }

  return names;
}

export function sampleMentionNames<F>(
  surface: PlaceholderSurface<F>,
  lookup: PlaceholderLookup,
  texts: Iterable<string>,
): MentionNames {
  return mentionNamesFor(surface, lookup, usedKeys(surface, texts));
}

export function previewMessage<F, M extends ProtonMessageLike>(
  surface: PlaceholderSurface<F>,
  message: M,
  sample: SurfaceSample<F>,
  overrides?: Partial<F> | undefined,
): MessagePreview<M> {
  const keys = usedKeys(
    surface,
    collectMessageSites(message, '').map(({ text }) => text),
  );
  const lookup = surface.build(factsFor(sample, overrides), { now: SAMPLE_NOW, keys });
  const result = renderMessageTemplate(message, surface, lookup, { now: SAMPLE_NOW });
  const shared = {
    caption: previewCaption(sample, overrides),
    mentionNames: mentionNamesFor(surface, lookup, keys),
    now: SAMPLE_NOW,
  };

  return result.ok
    ? { ...shared, message: result.message, diagnostics: result.diagnostics, problem: undefined }
    : { ...shared, message, diagnostics: result.diagnostics, problem: result.humanReason };
}

export function previewText<F>(
  surface: PlaceholderSurface<F>,
  path: string,
  text: string,
  sample: SurfaceSample<F>,
  overrides?: Partial<F> | undefined,
): TextPreview {
  const spec = surface.fieldAt(path);
  if (spec === undefined) {
    throw new Error(
      `The ${surface.label} placeholders have no field at ${path}, so it cannot be previewed.`,
    );
  }

  const keys = usedKeys(surface, [text]);
  const lookup = surface.build(factsFor(sample, overrides), { now: SAMPLE_NOW, keys });
  const rendered = renderTemplate(text, lookup, {
    registry: surface.registry,
    field: spec.kind,
    channel: spec.channel,
    event: surface.event,
    audience: surface.audience,
    now: SAMPLE_NOW,
  }).output;
  const finished = spec.finish === undefined ? rendered : spec.finish(rendered);

  return {
    text: spec.limit === undefined ? finished : clipGraphemes(finished, spec.limit),
    caption: previewCaption(sample, overrides),
    mentionNames: mentionNamesFor(surface, lookup, keys),
    now: SAMPLE_NOW,
  };
}
