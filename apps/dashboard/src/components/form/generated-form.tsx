import type { FieldDescriptor } from '@proton/core';
import { type ReactElement, useMemo } from 'react';
import type { DiscordChannel, DiscordRole, FieldSlot } from './fields.tsx';
import { type MatrixLayout, matrixFor, toMatrix } from './matrix.ts';
import { resolveFieldComponent } from './registry.tsx';
import { type RuleRow, ruleIsOff, toRows } from './rules.ts';
import { SectionCard } from './section.tsx';

export interface FormSection {
  id: string;
  title: string;
  fields: string[];
}

export interface GeneratedFormProps {
  descriptors: readonly FieldDescriptor[];
  values: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
  channels?: readonly DiscordChannel[] | undefined;
  roles?: readonly DiscordRole[] | undefined;
  sections?: readonly FormSection[] | undefined;
  scope?: string | undefined;

  // A section the page's own h1 has already named. It renders headerless rather than stacking a
  // third identical heading under the first two.
  suppressTitle?: string | undefined;
}

export interface DescriptorGroup {
  id: string;
  title: string | null;
  descriptors: FieldDescriptor[];
}

export function fieldIsHidden(
  descriptor: FieldDescriptor,
  values: Record<string, unknown>,
): boolean {
  const when = descriptor.showWhen;
  if (when === undefined) return false;

  // Fails open where the controller is not on the form at all — the module switch is stripped out
  // of it, so a showWhen aimed there resolves to nothing and would hide the field in every state.
  if (!Object.hasOwn(values, when.path)) return false;

  return !when.equals.includes(String(values[when.path]));
}

function groupIsHidden(group: DescriptorGroup, values: Record<string, unknown>): boolean {
  return group.descriptors.every((descriptor) => fieldIsHidden(descriptor, values));
}

// What is keeping a hidden field off the page. Named by its option label, not by the schema
// string: 'captcha' is not what the mode selector reads, so it is not what to tell an admin.
export function hiddenBy(
  descriptor: FieldDescriptor,
  descriptors: readonly FieldDescriptor[],
  values: Record<string, unknown>,
): string | null {
  const when = descriptor.showWhen;
  if (when === undefined || !fieldIsHidden(descriptor, values)) return null;

  const controller = descriptors.find((candidate) => candidate.path === when.path);
  const reads = when.equals.map((option) =>
    controller?.kind === 'enum' ? (controller.optionLabels?.[option] ?? option) : option,
  );

  return `“${controller?.label ?? when.path}” is “${reads.join('” or “')}”`;
}

// Claimed by the path's first segment, and anything unclaimed still renders in a trailing group:
// a manifest that forgets a field must not make that field unreachable.
export function groupBySection(
  descriptors: readonly FieldDescriptor[],
  sections: readonly FormSection[] | undefined,
): DescriptorGroup[] {
  // An area that declares only panels shows no sections at all, and returning one untitled group
  // there rendered an empty card — two hairlines and forty pixels above the panel it was hiding.
  if (descriptors.length === 0) return [];

  if (!sections || sections.length === 0) {
    return [{ id: 'all', title: null, descriptors: [...descriptors] }];
  }

  const claimed = new Set<string>();
  const groups: DescriptorGroup[] = [];

  for (const section of sections) {
    const rank = (d: FieldDescriptor): number =>
      section.fields.indexOf(d.path.split('.')[0] ?? d.path);

    // Ordered by the section's own list rather than by the Zod shape. Serverlog declares
    // `['categories', 'categoryChannels']` as two parallel objects, and shape order puts all
    // thirteen of one before all thirteen of the other whichever way the manifest reads.
    const owned = descriptors.filter((d) => rank(d) !== -1).sort((a, b) => rank(a) - rank(b));

    for (const d of owned) claimed.add(d.path);
    if (owned.length > 0) {
      groups.push({ id: section.id, title: section.title, descriptors: owned });
    }
  }

  const rest = descriptors.filter((d) => !claimed.has(d.path));
  if (rest.length > 0) {
    groups.push({ id: 'other', title: null, descriptors: rest });
  }

  return groups;
}

export function sectionKey(scope: string | undefined, id: string): string {
  return scope === undefined ? id : `${scope}:${id}`;
}

interface ControlProps {
  values: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
  channels?: readonly DiscordChannel[] | undefined;
  roles?: readonly DiscordRole[] | undefined;
}

function Control({
  descriptor,
  param,
  values,
  onChange,
  channels,
  roles,
}: ControlProps & {
  descriptor: FieldDescriptor;
  param?: FieldSlot | undefined;
}): ReactElement {
  const Field = resolveFieldComponent(descriptor);

  return (
    <Field
      descriptor={descriptor}
      value={values[descriptor.path]}
      onChange={(value) => onChange(descriptor.path, value)}
      channels={channels}
      roles={roles}
      param={param}
      // On the field's own root, never unmounted and never wrapped: a save writes and can be
      // rejected for a hidden field, and a wrapper breaks the `.field + .field` row separator.
      hidden={fieldIsHidden(descriptor, values)}
    />
  );
}

/**
 * Two parallel objects rendered as the table they are. As plain rows this section was every key's
 * switch followed by every key's channel — twenty-six rows carrying thirteen labels twice, with a
 * category's two halves a full screen apart.
 */
function Matrix({ layout, ...rest }: ControlProps & { layout: MatrixLayout }): ReactElement {
  return (
    <table className="matrix">
      <thead>
        <tr>
          <th scope="col">{layout.spec.rows}</th>
          {layout.spec.columns.map((column) => (
            <th scope="col" key={column.root}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {layout.rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">{row.label}</th>
            {row.cells.map((descriptor, index) => {
              const column = layout.spec.columns[index];

              return (
                <td
                  key={column?.root ?? index}
                  data-kind={descriptor?.kind}
                  // Read back as the cell's own visible label once the table reflows to a block
                  // per row on a phone and the column headers stop being above anything.
                  data-label={column?.label}
                >
                  {descriptor && column ? (
                    <Control
                      descriptor={descriptor}
                      // Named per cell: every control in a column carries the same label, and a
                      // row of controls all called "Server" is a row nobody can navigate by ear.
                      param={{
                        label: undefined,
                        name: `${row.label} — ${column.label}`,
                        emptyLabel: column.emptyLabel,
                      }}
                      {...rest}
                    />
                  ) : null}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Rule({ rule, ...rest }: ControlProps & { rule: RuleRow }): ReactElement {
  const off = ruleIsOff(rule, rest.values);

  const params = rule.params.map((param) => (
    <Control
      key={param.descriptor.path}
      descriptor={param.descriptor}
      param={{ label: param.label }}
      {...rest}
    />
  ));

  const body = rule.head && (params.length > 0 || rule.stacked.length > 0);

  return (
    <div className="rule" data-rule={rule.id} data-off={off ? 'true' : undefined}>
      <div className="rule-head">
        <span className="rule-label">{rule.label}</span>
        <div className="rule-controls">
          {rule.head ? (
            <Control descriptor={rule.head} param={{ label: undefined }} {...rest} />
          ) : (
            params
          )}
        </div>
      </div>

      {/* Hidden, never unmounted. An off rule still holds real values that a save can be rejected
          for, and the command palette still indexes them — both need a [data-path] to land on. */}
      {body ? (
        <div className="rule-body" hidden={off}>
          {params.length > 0 ? <div className="rule-params">{params}</div> : null}
          {rule.stacked.map((descriptor) => (
            <Control key={descriptor.path} descriptor={descriptor} {...rest} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function GeneratedForm({
  descriptors,
  values,
  onChange,
  channels,
  roles,
  sections,
  scope,
  suppressTitle,
}: GeneratedFormProps): ReactElement {
  // Deliberately not keyed on `values`: grouping, the matrix layout and toRows' stemming would all
  // rerun on every keystroke. Only the hidden flag reads values, and it is an O(n) pass per render.
  const groups = useMemo(() => groupBySection(descriptors, sections), [descriptors, sections]);

  // A section is a matrix or it is rows, never both halves of one: toMatrix hands back the fields
  // no column claimed so they keep rendering underneath it.
  const laid = useMemo(
    () =>
      groups.map((group) => {
        const spec = matrixFor(scope, group.id);
        const matrix = spec ? toMatrix(group.descriptors, spec) : undefined;

        return { matrix, rows: toRows(matrix ? matrix.rest : group.descriptors) };
      }),
    [groups, scope],
  );

  return (
    <div className="generated-form">
      {groups.map((group, index) => {
        const card = (
          <SectionCard
            key={group.id}
            id={sectionKey(scope, group.id)}
            title={group.title === suppressTitle ? null : group.title}
          >
            {laid[index]?.matrix ? (
              <Matrix
                layout={laid[index].matrix}
                values={values}
                onChange={onChange}
                channels={channels}
                roles={roles}
              />
            ) : null}

            {(laid[index]?.rows ?? []).map((row) =>
              row.kind === 'field' ? (
                <Control
                  key={row.descriptor.path}
                  descriptor={row.descriptor}
                  values={values}
                  onChange={onChange}
                  channels={channels}
                  roles={roles}
                />
              ) : (
                <Rule
                  key={row.id}
                  rule={row}
                  values={values}
                  onChange={onChange}
                  channels={channels}
                  roles={roles}
                />
              ),
            )}
          </SectionCard>
        );

        // A wrapper only because SectionCard owns its own <section> and its collapse state; a
        // section carries no adjacent-sibling rule, so nothing breaks the way it would on a field.
        return groupIsHidden(group, values) ? (
          <div key={group.id} hidden>
            {card}
          </div>
        ) : (
          card
        );
      })}
    </div>
  );
}
