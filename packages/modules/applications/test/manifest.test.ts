import { describe, expect, test } from 'bun:test';
import {
  type ActionKind,
  type ActionRequest,
  ModuleRegistry,
  Permissions,
  ProviderRegistry,
} from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  applicationsConfigSchema,
  applicationsDefaultConfig,
  applicationsFormSchema,
} from '../src/config.ts';
import { applicationsModule, createApplicationsModule } from '../src/index.ts';
import { runSweep } from '../src/jobs.ts';
import {
  ACCEPT_ROLE,
  APP_ID,
  APPLICANT,
  configWith,
  EffectsHarness,
  failure,
  GUILD,
  PING_ROLE,
  PUBLIC_CHANNEL,
  SUBMIT_ROLE,
} from './effects-harness.ts';

function registry(): ModuleRegistry {
  const built = new ModuleRegistry({ providers: new ProviderRegistry() });
  built.register(applicationsModule);
  return built;
}

async function everything(): Promise<EffectsHarness> {
  const h = new EffectsHarness(
    configWith(
      {
        panels: [{ id: 'staff', name: 'Staff', channelId: PUBLIC_CHANNEL, formIds: ['mods'] }],
      },
      {
        actions: {
          onSubmit: { addRoleIds: [SUBMIT_ROLE] },
          onAccept: { addRoleIds: [ACCEPT_ROLE], xp: 25 },
        },
        review: { pingRoleIds: [PING_ROLE] },
        interview: { ticketTypeId: 'interview' },
      },
    ),
  );

  const declared = new Set<ActionKind>(applicationsModule.actionKinds ?? []);
  const inner = h.ctx.executor.execute.bind(h.ctx.executor);
  h.ctx.executor = {
    execute: async (request: ActionRequest) => {
      if (!declared.has(request.kind)) throw new Error(`undeclared kind ${request.kind}`);
      return inner(request);
    },
  };

  await h.submit();
  await h.work(APP_ID);
  await h.openTicket();
  await h.work(APP_ID);
  h.respond = (request) =>
    request.kind === 'add_role'
      ? failure('role_hierarchy', `<@&${ACCEPT_ROLE}> is too high.`)
      : undefined;
  await h.accept();
  await h.work(APP_ID);
  h.respond = () => undefined;
  h.advance(3 * 24 * 60 * 60 * 1000);
  await runSweep(h.raw(), h.ctx);

  const panels = applicationsModule.listeners?.find((listener) =>
    listener.types.includes('proton.panel_requested'),
  );
  await panels?.handler(
    {
      id: 'proton.panel_requested:1',
      type: 'proton.panel_requested',
      guildId: GUILD,
      occurredAt: h.clock,
      payload: {
        auditId: 'audit-1',
        guildId: GUILD,
        moduleId: 'applications',
        panelId: 'staff',
        actorId: APPLICANT,
      },
    },
    h.ctx,
  );

  await h.store.deleteApplication({
    guildId: GUILD,
    applicationId: APP_ID,
    actor: { id: APPLICANT, source: 'web' },
    audit: {
      actorId: APPLICANT,
      source: 'dashboard',
      action: 'module.applications.delete',
      id: 'a',
    },
  });
  await h.work(APP_ID);
  return h;
}

describe('the manifest', () => {
  test('registers in a fresh registry', () => {
    expect(() => registry()).not.toThrow();
    expect(registry().get('applications')?.name).toBe('Applications');
  });

  test('a module built with nothing still registers, as the api and the command build need', () => {
    const built = new ModuleRegistry();
    expect(() => built.register(createApplicationsModule({}))).not.toThrow();
  });

  test('ships defaults its own schema accepts and that do nothing until turned on', () => {
    expect(applicationsConfigSchema.safeParse(applicationsDefaultConfig).success).toBe(true);
    expect(applicationsDefaultConfig.enabled).toBe(false);
    expect(applicationsDefaultConfig.forms).toEqual([]);
    expect(applicationsDefaultConfig.panels).toEqual([]);
  });

  test('keeps forms and panels out of the generated form', () => {
    const paths = registry()
      .descriptors('applications')
      .map((descriptor) => descriptor.path);
    expect(paths).not.toContain('forms');
    expect(paths).not.toContain('panels');
    expect(new Set(paths)).toEqual(new Set(Object.keys(applicationsFormSchema.shape)));
  });

  test('runs on the one unprivileged intent and asks to see and post in channels', () => {
    expect(applicationsModule.requiredIntents).toEqual([GatewayIntentBits.Guilds]);
    expect(applicationsModule.requiredPermissions).toEqual([
      Permissions.ViewChannel,
      Permissions.SendMessages,
    ]);
    expect(applicationsModule.category).toBe('utility');
  });

  test('declares every kind the whole workflow executes', async () => {
    const h = await everything();
    const executed = new Set(h.calls.map((call) => call.kind));

    const kinds = [
      'send',
      'edit_message',
      'delete_message',
      'create_dm',
      'add_role',
      'remove_role',
    ];
    for (const kind of kinds) {
      expect(`${kind}: ${executed.has(kind)}`).toBe(`${kind}: true`);
    }
    expect(applicationsModule.actionKinds).toEqual([
      'interaction_reply',
      'interaction_followup',
      'interaction_edit_original',
      'send',
      'edit_message',
      'delete_message',
      'create_dm',
      'add_role',
      'remove_role',
    ]);
    expect(h.invalid).toEqual([]);
  });

  test('emits every type the workflow publishes', async () => {
    const h = await everything();
    const emits = new Set(applicationsModule.emits ?? []);
    const published = [...new Set(h.published.map((entry) => entry.type))];

    expect(published.filter((type) => !emits.has(type))).toEqual([]);
    expect(published).toEqual(
      expect.arrayContaining([
        'applications.submitted',
        'applications.accepted',
        'applications.action_failed',
        'xp.grant_requested',
        'tickets.open_requested',
      ]),
    );
    expect(emits).toEqual(
      new Set([
        'applications.submitted',
        'applications.review_started',
        'applications.information_requested',
        'applications.information_provided',
        'applications.waitlisted',
        'applications.accepted',
        'applications.rejected',
        'applications.withdrawn',
        'applications.reopened',
        'applications.expired',
        'applications.action_failed',
        'applications.work_requested',
        'xp.grant_requested',
        'tickets.open_requested',
      ]),
    );
  });

  test('may hand a press’s follow-up work to its own listener', () => {
    const built = registry();
    expect(built.mayEmit('applications', 'applications.work_requested')).toBe(true);
    expect(
      applicationsModule.listeners?.some((listener) =>
        listener.types.includes('applications.work_requested'),
      ),
    ).toBe(true);
  });

  test('answers presses from a pool of eight', () => {
    expect(applicationsModule.interactionConcurrency).toBe(8);
  });

  test('caps forms and panels at the tier limits', () => {
    expect(applicationsModule.configLimits).toEqual([
      { key: 'applicationForms', path: 'forms' },
      { key: 'applicationPanels', path: 'panels' },
    ]);
  });

  test('offers every panel for posting, with or without a channel', () => {
    const config = configWith({
      panels: [
        { id: 'staff', name: 'Staff', channelId: PUBLIC_CHANNEL, formIds: ['mods'] },
        { id: 'later', name: 'Later', formIds: ['mods'] },
      ],
    });
    const offered = applicationsModule.postables?.(config) ?? [];
    expect(offered).toEqual([
      { id: 'staff', name: 'Staff', channelId: PUBLIC_CHANNEL },
      { id: 'later', name: 'Later' },
    ]);
    expect('channelId' in (offered[1] ?? {})).toBe(false);
  });

  test('names every role a saved config would hand out or take away', () => {
    const config = configWith(
      {},
      {
        actions: {
          onSubmit: { addRoleIds: [SUBMIT_ROLE] },
          onAccept: { removeRoleIds: [ACCEPT_ROLE] },
        },
      },
    );
    expect(applicationsModule.grantedRoles?.(config)).toEqual([
      {
        path: 'forms.0.actions.onSubmit.addRoleIds',
        roleId: SUBMIT_ROLE,
        scope: 'mods:onSubmit:add',
      },
      {
        path: 'forms.0.actions.onAccept.removeRoleIds',
        roleId: ACCEPT_ROLE,
        scope: 'mods:onAccept:remove',
      },
    ]);
  });

  test('sweeps per server, even while off for privacy work, and purges globally every hour', () => {
    expect(applicationsModule.schedules).toEqual(['sweep']);
    expect(typeof applicationsModule.scheduledHandlers?.sweep).toBe('function');
    expect(applicationsModule.scheduledWhileDisabled).toEqual(['sweep']);
    expect(applicationsModule.jobs).toEqual([{ id: 'purge', cron: '15 * * * *' }]);
  });

  test('ships /apply and /applications', () => {
    expect(applicationsModule.commands?.map((command) => command.name)).toEqual([
      'apply',
      'applications',
    ]);
  });

  test('listens for presses, autocomplete and the events that drive its outbox', () => {
    expect(applicationsModule.listeners?.map((listener) => listener.types)).toEqual([
      ['interaction.component', 'interaction.modal'],
      ['interaction.autocomplete'],
      ['proton.panel_requested'],
      ['proton.config_changed'],
      ['guild.available'],
      ['applications.work_requested'],
      ['xp.granted'],
      ['tickets.open_answered'],
    ]);
  });

  test('every dashboard section names a real config key', () => {
    const keys = new Set(Object.keys(applicationsConfigSchema.shape));
    expect(applicationsModule.dashboard?.icon).toBe('identification-card');
    for (const section of applicationsModule.dashboard?.sections ?? []) {
      for (const field of section.fields) expect(keys.has(field)).toBe(true);
    }
  });

  test('renders every simulation through a surface it declares', () => {
    const surfaces = applicationsModule.templates?.surfaces ?? {};
    for (const { descriptor } of applicationsModule.simulations ?? []) {
      if (descriptor.surfaceId !== undefined) {
        expect(Object.hasOwn(surfaces, descriptor.surfaceId)).toBe(true);
      }
    }
  });
});
