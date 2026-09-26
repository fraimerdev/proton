import { describe, expect, test } from 'bun:test';
import { MESSAGE_FLAG_IS_COMPONENTS_V2 } from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import {
  type ApplicationsConfig,
  applicationsConfigSchema,
  type PanelConfig,
} from '../src/config.ts';
import { APPLICANT_ACTION, customId } from '../src/interface.ts';
import { buildPanel, sendPanel } from '../src/panel.ts';
import {
  buttonsOf,
  countComponents,
  customIdsOf,
  GUILD,
  harness,
  moderatorForm,
  PANEL_CHANNEL,
  panelOf,
  textsOf,
} from './applicant-harness.ts';

function forms(count: number) {
  return Array.from({ length: count }, (_, index) =>
    moderatorForm({ id: `form-${index}`, name: `Form ${index}` }),
  );
}

function configWith(formCount: number, panel: Record<string, unknown> = {}): ApplicationsConfig {
  const all = forms(formCount);
  return applicationsConfigSchema.parse({
    enabled: true,
    forms: all,
    panels: [
      panelOf({
        formIds: all.map((form) => form.id).slice(0, panel.style === 'select' ? 25 : 10),
        ...panel,
      }),
    ],
  });
}

function onlyPanel(config: ApplicationsConfig): PanelConfig {
  const panel = config.panels[0];
  if (!panel) throw new Error('no panel');
  return panel;
}

function built(config: ApplicationsConfig, panel: PanelConfig = onlyPanel(config)) {
  const result = buildPanel(config, panel);
  if (!result.ok) throw new Error(result.humanReason);
  return result.components;
}

describe('building a panel', () => {
  test('a buttons panel holds ten forms, five to a row, plus My applications', () => {
    const config = configWith(10, { title: 'Join the team', body: 'Pick a role below.' });
    const components = built(config);

    const container = components[0] as Record<string, unknown>;
    expect(components).toHaveLength(1);
    expect(container.type).toBe(ComponentType.Container);
    expect(textsOf(components)).toEqual(['## Join the team\nPick a role below.']);

    const buttons = buttonsOf(components);
    expect(buttons.map((button) => button.label)).toEqual([
      ...forms(10).map((form) => form.name),
      'My applications',
    ]);
    expect(buttons[0]?.customId).toBe(customId(APPLICANT_ACTION.open, 'staff', 'form-0'));
    expect(buttons.at(-1)?.customId).toBe(customId(APPLICANT_ACTION.mine));

    const rows = (container.components as Array<Record<string, unknown>>).filter(
      (part) => part.type === ComponentType.ActionRow,
    );
    expect(rows.map((row) => (row.components as unknown[]).length)).toEqual([5, 5, 1]);
    expect(countComponents(components)).toBeLessThanOrEqual(40);
  });

  test('a buttons panel with more than ten forms is refused with the way out', () => {
    const config = configWith(11);
    const panel = { ...onlyPanel(config), formIds: config.forms.map((form) => form.id) };

    const result = buildPanel(config, panel);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.humanReason).toContain('lists 11 forms and a panel with buttons holds 10');
      expect(result.humanReason).toContain('Switch it to a dropdown');
    }
  });

  test('a dropdown panel holds twenty-five forms in one select', () => {
    const config = configWith(25, { style: 'select' });
    const components = built(config);

    const selects: Array<Record<string, unknown>> = [];
    const walk = (nodes: unknown): void => {
      for (const node of (nodes as Array<Record<string, unknown>>) ?? []) {
        if (node.type === ComponentType.StringSelect) selects.push(node);
        if (Array.isArray(node.components)) walk(node.components);
      }
    };
    walk(components);

    expect(selects).toHaveLength(1);
    const select = selects[0] ?? {};
    expect(select.custom_id).toBe(customId(APPLICANT_ACTION.openSelect, 'staff'));
    expect(select.options).toHaveLength(25);
    expect((select.options as Array<Record<string, unknown>>)[0]).toMatchObject({
      label: 'Form 0',
      value: 'form-0',
      description: 'Help keep the server friendly.',
    });
    expect(customIdsOf(components)).toContain(customId(APPLICANT_ACTION.mine));
  });

  test('a dropdown with more than twenty-five forms is refused', () => {
    const config = configWith(25, { style: 'select' });
    const panel = {
      ...onlyPanel(config),
      formIds: [...config.forms.map((form) => form.id), 'form-extra'],
    };
    const extra = { ...config, forms: [...config.forms, moderatorForm({ id: 'form-extra' })] };

    const result = buildPanel(extra, panel);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.humanReason).toContain('a dropdown holds 25');
  });

  test('archived and closed forms stay on the panel so a press can explain', () => {
    const config = applicationsConfigSchema.parse({
      enabled: true,
      forms: [
        moderatorForm(),
        moderatorForm({ id: 'old', name: 'Old Form', archived: true }),
        moderatorForm({ id: 'shut', name: 'Shut Form', intake: { open: false } }),
      ],
      panels: [panelOf({ formIds: ['mods', 'old', 'shut'] })],
    });

    expect(buttonsOf(built(config)).map((button) => button.label)).toEqual([
      'Moderator Application',
      'Old Form',
      'Shut Form',
      'My applications',
    ]);
  });

  test('My applications can be left off, and the colour is the panel’s own', () => {
    const config = configWith(2, { showMine: false, colour: 0x123456 });
    const components = built(config);
    expect(customIdsOf(components)).not.toContain(customId(APPLICANT_ACTION.mine));
    expect((components[0] as Record<string, unknown>).accent_color).toBe(0x123456);
  });

  test('a panel whose forms are all gone is refused', () => {
    const config = configWith(1);
    const result = buildPanel({ ...config, forms: [] }, onlyPanel(config));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.humanReason).toContain('lists no forms that exist');
  });
});

describe('posting a panel', () => {
  test('it is sent once as a Components V2 message with no pings', async () => {
    const h = harness();
    const ctx = h.context();
    const panel = onlyPanel(ctx.config);

    const result = await sendPanel(ctx, panel, {
      actorId: '400000000000000009',
      idempotencyKey: 'audit-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.messageId).toBe('string');

    const sends = h.executed.filter((entry) => entry.request.kind === 'send');
    expect(sends).toHaveLength(1);
    const request = sends[0]?.request;
    expect(request?.idempotencyKey).toBe('audit-1:panel');
    expect(request?.record).toBe(false);
    expect(request?.guildId).toBe(GUILD);
    expect(request?.payload).toMatchObject({
      channelId: PANEL_CHANNEL,
      flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
      allowedMentions: { parse: [] },
    });

    const again = await sendPanel(ctx, panel, {
      actorId: '400000000000000009',
      idempotencyKey: 'audit-1',
    });
    expect(again.ok).toBe(true);
    expect(
      h.rest.calls.filter((call) => call.path === `/channels/${PANEL_CHANNEL}/messages`),
    ).toHaveLength(1);
  });

  test('a panel without a channel is refused before anything is sent', async () => {
    const h = harness();
    const ctx = h.context();
    const { channelId: _channel, ...rest } = onlyPanel(ctx.config);

    const result = await sendPanel(ctx, rest, {
      actorId: '400000000000000009',
      idempotencyKey: 'audit-2',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.humanReason).toContain('has no channel to post in');
    expect(h.executed).toEqual([]);
  });

  test('more panels than the tier allows are refused', async () => {
    const h = harness({
      panels: [
        panelOf(),
        panelOf({ id: 'two', name: 'Two' }),
        panelOf({ id: 'three', name: 'Three' }),
      ],
    });
    const ctx = h.context();

    const result = await sendPanel(ctx, onlyPanel(ctx.config), {
      actorId: '400000000000000009',
      idempotencyKey: 'audit-3',
    });
    expect(result.ok).toBe(false);
    expect(h.executed).toEqual([]);
  });

  test('Discord refusing the message is reported, not swallowed', async () => {
    const h = harness();
    h.rest.fail(`/channels/${PANEL_CHANNEL}/messages`, {
      status: 403,
      body: { code: 50013, message: 'Missing Permissions' },
    });
    const ctx = h.context();

    const result = await sendPanel(ctx, onlyPanel(ctx.config), {
      actorId: '400000000000000009',
      idempotencyKey: 'audit-4',
    });
    expect(result.ok).toBe(false);
  });
});
