import type { FieldDescriptor } from '@proton/core';

export interface RuleParam {
  descriptor: FieldDescriptor;

  // Undefined when the param's own label says nothing the rule's label has not already said.
  label: string | undefined;
}

export interface RuleRow {
  kind: 'rule';
  id: string;
  label: string;

  head: FieldDescriptor | undefined;
  params: RuleParam[];
  stacked: FieldDescriptor[];
}

export interface FieldRow {
  kind: 'field';
  descriptor: FieldDescriptor;
}

export type FormRow = RuleRow | FieldRow;

// A control whose height does not depend on its contents, and so may sit on one line beside its
// siblings. See DESIGN.md's Stacked-When-It-Grows Rule: everything else takes the full width.
const INLINE_KINDS: ReadonlySet<string> = new Set([
  'boolean',
  'number',
  'enum',
  'duration',
  'channel-id',
  'role-id',
]);

export function words(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
}

// Enough to make 'links'/'link' and 'attachments'/'attachment' the same subject. It is not a
// stemmer: a miss only costs a grouping, never a wrong one, because both sides normalise alike.
export function singular(word: string): string {
  return word.length >= 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function stem(path: string): string[] {
  return words(path).map(singular);
}

function sharedPrefix(all: readonly string[][]): string[] {
  const first = all[0];
  if (!first) return [];

  let length = 0;
  while (length < first.length && all.every((candidate) => candidate[length] === first[length])) {
    length += 1;
  }

  return first.slice(0, length);
}

function sentence(text: string): string {
  return text.length === 0 ? text : text[0]?.toUpperCase() + text.slice(1);
}

/**
 * What a param is called once its rule has taken the family name. `severity('Message flood')`
 * heads a rule whose members are labelled `Flood: window` — the colon is the module's own way of
 * saying "this belongs to that", and everything after it is the part the rule has not said yet.
 */
export function paramLabel(label: string, ruleLabel: string): string | undefined {
  const colon = label.indexOf(': ');
  if (colon > 0) return sentence(label.slice(colon + 2));

  const own = words(label);
  const rule = words(ruleLabel);
  const shared = sharedPrefix([own.map(singular), rule.map(singular)]).length;

  if (shared === own.length && shared === rule.length) return undefined;

  // Only a whole rule label is dropped. 'Blocked domains' under 'Blocked links' shares a word that
  // is doing work in both — cutting it leaves 'Domains' beside 'Allowed domains', which is a pair
  // the reader now has to reconstruct.
  return shared === rule.length ? sentence(own.slice(shared).join(' ')) : label;
}

function ruleLabelOf(
  head: FieldDescriptor | undefined,
  members: readonly FieldDescriptor[],
): string {
  if (head) return head.label;

  const labels = members.map((member) => words(member.label));
  const shared = sharedPrefix(labels.map((word) => word.map(singular))).length;

  const shortest = labels.reduce((best, candidate) =>
    candidate.length < best.length ? candidate : best,
  );

  return shared === 0
    ? sentence(shortest.join(' '))
    : sentence(shortest.slice(0, shared).join(' '));
}

// Nested paths are left alone: two leaves under one parent are one setting's parts, already
// grouped by the parent, and pairing them across parents needs copy this cannot derive.
function groupable(descriptor: FieldDescriptor): boolean {
  return !descriptor.path.includes('.');
}

function buildRule(id: string, members: readonly FieldDescriptor[]): RuleRow {
  const head = members.find((member) => /severity$/i.test(member.path));
  const label = ruleLabelOf(head, members);
  const rest = members.filter((member) => member !== head);

  return {
    kind: 'rule',
    id,
    label,
    head,
    params: rest
      .filter((member) => INLINE_KINDS.has(member.kind))
      .map((descriptor) => ({ descriptor, label: paramLabel(descriptor.label, label) })),
    stacked: rest.filter((member) => !INLINE_KINDS.has(member.kind)),
  };
}

/**
 * Folds a section's field families into one row each — `floodSeverity` / `floodCount` /
 * `floodWindow` is one rule with two settings, not three unrelated rows. Applied only where it
 * earns itself: a section holding a single family reads better as plain rows, and a form that
 * groups in one section and not the next has lost the alignment line for nothing.
 */
export function toRows(descriptors: readonly FieldDescriptor[]): FormRow[] {
  const buckets = new Map<string, FieldDescriptor[]>();

  for (const descriptor of descriptors) {
    if (!groupable(descriptor)) continue;

    const first = stem(descriptor.path)[0];
    if (first === undefined) continue;

    buckets.set(first, [...(buckets.get(first) ?? []), descriptor]);
  }

  const claimed = new Map<string, RuleRow>();

  for (const [first, members] of buckets) {
    if (members.length < 2) continue;

    const prefix = sharedPrefix(members.map((member) => stem(member.path)));

    // A member that is nothing but the prefix is the family's own switch — `card` over
    // `cardAccent` — and heads the section rather than joining a row inside it.
    const inner = members.filter((member) => stem(member.path).length > prefix.length);
    if (inner.length < 2) continue;

    const rule = buildRule(first, inner);
    for (const member of inner) claimed.set(member.path, rule);
  }

  const rules = new Set(claimed.values());
  if (rules.size < 2) return descriptors.map((descriptor) => ({ kind: 'field', descriptor }));

  const rows: FormRow[] = [];
  const emitted = new Set<RuleRow>();

  for (const descriptor of descriptors) {
    const rule = claimed.get(descriptor.path);

    if (!rule) {
      rows.push({ kind: 'field', descriptor });
      continue;
    }

    if (emitted.has(rule)) continue;

    emitted.add(rule);
    rows.push(rule);
  }

  return rows;
}

export const OFF = 'off';

// Whether a rule's own severity has switched it off, in which case its settings are not worth the
// eleven rows they cost: they keep their saved values and come back the moment it is switched on.
export function ruleIsOff(rule: RuleRow, values: Record<string, unknown>): boolean {
  const head = rule.head;

  if (head?.kind !== 'enum') return false;
  if (!head.options.includes(OFF)) return false;

  return values[head.path] === OFF;
}
