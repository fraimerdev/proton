import type { FormConfig, OutcomeActions, OutcomeKey } from '@proton/module-applications/config';
import { XP_REWARD_MAX } from '@proton/module-applications/constants';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { RoleMultiPicker } from '../../components/discord/role-picker.tsx';
import { NumberStepper, Select, Switch } from '../../components/ui/controls.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { readFailure } from '../../lib/errors.ts';
import { moduleConfigQuery, modulesQuery, rolesQuery } from '../../lib/queries.ts';
import { type ApplicationsForm, outcomeSteps, updateFormAt, withOptional } from './shape.ts';

const OUTCOME_ROLES_MAX = 10;

const TRIGGERS: readonly { key: OutcomeKey; title: string; description: string }[] = [
  {
    key: 'onSubmit',
    title: 'When sent',
    description: 'As soon as someone sends an application.',
  },
  { key: 'onAccept', title: 'When accepted', description: 'When staff accept it.' },
  { key: 'onReject', title: 'When rejected', description: 'When staff reject it.' },
  {
    key: 'onWaitlist',
    title: 'When waitlisted',
    description: 'When staff put it on the waitlist.',
  },
  { key: 'onWithdraw', title: 'When withdrawn', description: 'When the applicant withdraws it.' },
];

const ROLES_HELP =
  'Proton gives only roles below its own highest role, and you can only choose roles you could ' +
  'give yourself. A role change that fails never undoes the decision; staff see it and can retry.';

const TICKET_TYPE_NONE = '';

const WHAT_HAPPENS =
  'What Proton does at each step with the settings on this page. This is only a summary: nothing ' +
  'here gives roles, XP or tickets.';

const NOTHING_HAPPENS = 'Proton changes no roles, gives no XP and opens no tickets for this form.';

const ticketTypesSchema = z.object({
  types: z.array(z.object({ id: z.string(), name: z.string() })).catch([]),
});

function RolesPair({
  guildId,
  outcome,
  path,
  errorAt,
  onChange,
}: {
  guildId: string;
  outcome: OutcomeActions[OutcomeKey];
  path: string;
  errorAt: (path: string) => string | undefined;
  onChange: (patch: { addRoleIds?: string[]; removeRoleIds?: string[] }) => void;
}): ReactElement {
  const addError = errorAt(`${path}.addRoleIds`);
  const removeError = errorAt(`${path}.removeRoleIds`);

  return (
    <div className="applications-role-pair">
      <div className="stack stack-6">
        <span className="row-detail-label">Give</span>
        <RoleMultiPicker
          guildId={guildId}
          label="Add a role to give"
          max={OUTCOME_ROLES_MAX}
          requireAssignable
          invalid={addError !== undefined}
          value={outcome.addRoleIds}
          onChange={(addRoleIds) => onChange({ addRoleIds })}
        />
        {addError !== undefined ? (
          <span className="field-error" role="alert">
            {addError}
          </span>
        ) : null}
      </div>
      <div className="stack stack-6">
        <span className="row-detail-label">Take away</span>
        <RoleMultiPicker
          guildId={guildId}
          label="Add a role to take away"
          max={OUTCOME_ROLES_MAX}
          requireAssignable
          invalid={removeError !== undefined}
          value={outcome.removeRoleIds}
          onChange={(removeRoleIds) => onChange({ removeRoleIds })}
        />
        {removeError !== undefined ? (
          <span className="field-error" role="alert">
            {removeError}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function ActionsTab({
  form,
  guildId,
  index,
  current,
}: {
  form: ApplicationsForm;
  guildId: string;
  index: number;
  current: FormConfig;
}): ReactElement {
  const modules = useQuery(modulesQuery(guildId));
  const tickets = useQuery(moduleConfigQuery(guildId, 'tickets'));
  const roles = useQuery(rolesQuery(guildId));
  const actions = current.actions;
  const path = `forms.${index}.actions`;

  const moduleOn = (id: string): boolean | undefined =>
    modules.data?.modules.find((module) => module.id === id)?.enabled;
  const levelingOff = moduleOn('leveling') === false;
  const ticketsOff = moduleOn('tickets') === false;

  const types = ticketTypesSchema.safeParse(tickets.data?.config ?? {});
  const ticketTypes = types.success ? types.data.types : [];

  const steps = outcomeSteps(current, {
    roles: roles.data,
    leveling: moduleOn('leveling'),
    tickets: moduleOn('tickets'),
    ticketTypes: tickets.data === undefined ? undefined : ticketTypes,
  });
  const chosen = current.interview.ticketTypeId;
  const missingType =
    chosen !== undefined && tickets.data !== undefined && !ticketTypes.some((t) => t.id === chosen);

  const setActions = (change: (value: OutcomeActions) => OutcomeActions): void =>
    updateFormAt(form, index, (value) => ({ ...value, actions: change(value.actions) }));

  const overlap = (key: OutcomeKey): string | undefined =>
    actions[key].addRoleIds.some((id) => actions[key].removeRoleIds.includes(id))
      ? 'A role can’t be both given and taken away. Take it out of one of the two lists.'
      : undefined;

  return (
    <>
      <Section label="Roles" help={ROLES_HELP}>
        <Rows>
          {TRIGGERS.map((trigger) => (
            <SettingRow
              key={trigger.key}
              stacked
              title={trigger.title}
              description={trigger.description}
              error={overlap(trigger.key)}
            >
              <RolesPair
                guildId={guildId}
                outcome={actions[trigger.key]}
                path={`${path}.${trigger.key}`}
                errorAt={form.errorAt}
                onChange={(patch) =>
                  setActions((value) => ({
                    ...value,
                    [trigger.key]: { ...value[trigger.key], ...patch },
                  }))
                }
              />
            </SettingRow>
          ))}

          <SettingRow
            title="Clean up when it closes"
            description="Take back the roles given when it was sent once it’s accepted, rejected, withdrawn or expires. Only roles Proton gave for this application are removed, never ones they already had."
          >
            <Switch
              label="Clean up when it closes"
              checked={actions.removeSubmitRolesOnClose}
              onChange={(removeSubmitRolesOnClose) =>
                setActions((value) => ({ ...value, removeSubmitRolesOnClose }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="Other modules">
        <Rows>
          <SettingRow
            title="XP when accepted"
            description="Given once per application, even if it’s reopened and accepted again. 0 gives none."
            note={levelingOff ? 'Needs Leveling, which is off.' : undefined}
            error={
              levelingOff && actions.onAccept.xp > 0
                ? 'Needs Leveling, which is off. The XP isn’t given while it’s off, and staff see it as a failed action.'
                : form.errorAt(`${path}.onAccept.xp`)
            }
          >
            <NumberStepper
              label="XP when accepted"
              unit="XP"
              width={148}
              min={0}
              max={XP_REWARD_MAX}
              value={actions.onAccept.xp}
              onChange={(next) =>
                setActions((value) => ({
                  ...value,
                  onAccept: { ...value.onAccept, xp: next ?? 0 },
                }))
              }
            />
          </SettingRow>

          <SettingRow
            title="Interview ticket"
            description="The ticket type staff open when they choose Open interview ticket. Applications never open one on their own."
            note={
              ticketsOff
                ? 'Needs Tickets, which is off. Staff can’t open interview tickets until it’s on.'
                : tickets.data !== undefined && ticketTypes.length === 0
                  ? 'Tickets has no ticket types yet. Create one in Tickets first.'
                  : undefined
            }
            error={
              tickets.isError
                ? readFailure(tickets.error, 'the ticket types')
                : missingType
                  ? 'That ticket type no longer exists. Choose another or none.'
                  : form.errorAt(`forms.${index}.interview.ticketTypeId`)
            }
          >
            <Select
              width="md"
              aria-label="Interview ticket type"
              placeholder="None"
              options={[
                { value: TICKET_TYPE_NONE, label: 'None' },
                ...ticketTypes.map((type) => ({ value: type.id, label: type.name })),
                ...(missingType && chosen !== undefined
                  ? [{ value: chosen, label: `${chosen} (deleted)`, disabled: true }]
                  : []),
              ]}
              value={chosen ?? TICKET_TYPE_NONE}
              onChange={(next) =>
                updateFormAt(form, index, (value) => ({
                  ...value,
                  interview: withOptional(
                    value.interview,
                    'ticketTypeId',
                    next === TICKET_TYPE_NONE ? undefined : next,
                  ),
                }))
              }
            />
          </SettingRow>
        </Rows>
      </Section>

      <Section label="What happens" intro={WHAT_HAPPENS}>
        {steps.length === 0 ? (
          <p className="applications-now">{NOTHING_HAPPENS}</p>
        ) : (
          <Rows>
            {steps.map((step) => (
              <SettingRow key={step.key} stacked title={step.title}>
                <ul className="applications-lines">
                  {step.lines.map((line) => (
                    <li key={line.id}>
                      <span className="stack stack-4">
                        <span>{line.text}</span>
                        {line.warning !== undefined ? (
                          <span className="text-xs text-warning">{line.warning}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </SettingRow>
            ))}
          </Rows>
        )}
      </Section>
    </>
  );
}
