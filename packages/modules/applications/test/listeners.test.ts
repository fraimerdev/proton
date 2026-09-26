import { describe, expect, test } from 'bun:test';
import type { EventType, ProtonEvent } from '@proton/core';
import type { ApplicationsDeps } from '../src/deps.ts';
import { createScheduledHandlers } from '../src/jobs.ts';
import { createApplicationsListeners, INFO_GRACE_MS } from '../src/listeners.ts';
import { requestWork } from '../src/runner.ts';
import { wakeSlot } from '../src/store.ts';
import { DAY_MS } from '../src/web.ts';
import {
  APP_ID,
  APPLICANT,
  configWith,
  EffectsHarness,
  GUILD,
  OTHER_GUILD,
  OWNER,
  PUBLIC_CHANNEL,
} from './effects-harness.ts';

function harness(settings: Parameters<typeof configWith>[0] = {}, form = {}) {
  return new EffectsHarness(configWith(settings, form));
}

let sequence = 0;

async function deliver(
  h: EffectsHarness,
  type: EventType,
  payload: Record<string, unknown>,
  deps: ApplicationsDeps = h.raw(),
): Promise<void> {
  sequence += 1;
  const event: ProtonEvent = {
    id: `${type}:${sequence}`,
    type,
    guildId: GUILD,
    occurredAt: h.clock,
    payload,
  };
  for (const listener of createApplicationsListeners(deps)) {
    if (listener.types.includes(type)) await listener.handler(event, h.ctx);
  }
}

const PANELS = {
  panels: [{ id: 'staff', name: 'Staff', channelId: PUBLIC_CHANNEL, formIds: ['mods'] }],
};

describe('posting a panel from the dashboard', () => {
  test('ignores a request meant for another module', async () => {
    const h = harness(PANELS);
    await deliver(h, 'proton.panel_requested', {
      auditId: 'audit-1',
      guildId: GUILD,
      moduleId: 'tickets',
      panelId: 'staff',
      actorId: OWNER,
    });

    expect(h.calls).toEqual([]);
  });

  test('posts the named panel, keyed on the audit id', async () => {
    const h = harness(PANELS);
    await deliver(h, 'proton.panel_requested', {
      auditId: 'audit-1',
      guildId: GUILD,
      moduleId: 'applications',
      panelId: 'staff',
      actorId: OWNER,
    });

    expect(h.calls.map((call) => [call.kind, call.key, call.payload.channelId])).toEqual([
      ['send', 'audit-1:panel', PUBLIC_CHANNEL],
    ]);
    expect(h.calls[0]?.request.actorId).toBe(OWNER);
  });

  test('says so when the panel is gone or the module is off', async () => {
    const h = harness(PANELS);
    await deliver(h, 'proton.panel_requested', {
      auditId: 'audit-2',
      guildId: GUILD,
      moduleId: 'applications',
      panelId: 'missing',
      actorId: OWNER,
    });
    h.config = { ...h.config, enabled: false };
    await deliver(h, 'proton.panel_requested', {
      auditId: 'audit-3',
      guildId: GUILD,
      moduleId: 'applications',
      panelId: 'staff',
      actorId: OWNER,
    });

    expect(h.calls).toEqual([]);
    expect(h.logs.filter((log) => log.level === 'warn')).toHaveLength(2);
  });
});

function configChanged(moduleId: string, before: boolean, after: boolean, keys: string[] = []) {
  return {
    auditId: 'audit-9',
    guildId: GUILD,
    moduleId,
    actorId: OWNER,
    source: 'dashboard',
    enabledBefore: before,
    enabledAfter: after,
    changedKeys: keys,
  };
}

describe('turning the module on', () => {
  test('arms the sweep so paused effects resume', async () => {
    const h = harness();
    await deliver(h, 'proton.config_changed', configChanged('applications', false, true));

    const slot = wakeSlot(h.clock);
    expect(h.scheduled).toEqual([{ jobId: 'sweep', runAt: slot, naturalKey: `wake:${slot}` }]);
  });

  test('ignores other modules and saves that leave it as it was', async () => {
    const h = harness();
    await deliver(h, 'proton.config_changed', configChanged('tickets', false, true));
    await deliver(h, 'proton.config_changed', configChanged('applications', true, true, ['forms']));
    h.config = { ...h.config, enabled: false };
    await deliver(h, 'proton.config_changed', configChanged('applications', true, false));

    expect(h.scheduled).toEqual([]);
  });

  test('gives a question that came due while off a day’s grace before the sweep runs', async () => {
    const h = harness();
    await h.submit();
    await h.work(APP_ID);
    await h.requestInfo();
    await h.work(APP_ID);

    h.config = { ...h.config, enabled: false };
    h.advance(20 * DAY_MS);
    h.config = { ...h.config, enabled: true };
    await deliver(h, 'proton.config_changed', configChanged('applications', false, true));

    expect((await h.application()).infoDueAt).toBe(h.clock + INFO_GRACE_MS);
    await createScheduledHandlers(h.raw()).sweep({}, h.ctx);
    expect((await h.application()).status).toBe('needs_info');

    h.advance(INFO_GRACE_MS);
    await createScheduledHandlers(h.raw()).sweep({}, h.ctx);
    expect((await h.application()).status).toBe('expired');
  });

  test('a reconnect arms the sweep only while the module is on', async () => {
    const h = harness();
    await deliver(h, 'guild.available', {});
    expect(h.scheduled).toHaveLength(1);

    h.config = { ...h.config, enabled: false };
    await deliver(h, 'guild.available', {});
    expect(h.scheduled).toHaveLength(1);
  });
});

describe('changing how long answers are kept', () => {
  test('moves the purge of already decided applications to the new period', async () => {
    const h = harness();
    await h.submit();
    const accepted = await h.accept();
    expect(accepted.contentPurgeAt).toBe(h.clock + 30 * DAY_MS);

    h.config = { ...h.config, retentionDays: 7 };
    await deliver(
      h,
      'proton.config_changed',
      configChanged('applications', true, true, ['retentionDays']),
    );

    expect((await h.application()).contentPurgeAt).toBe((accepted.decidedAt ?? 0) + 7 * DAY_MS);
  });

  test('applies even while the module is off', async () => {
    const h = harness();
    await h.submit();
    const accepted = await h.accept();

    h.config = { ...h.config, enabled: false, retentionDays: 90 };
    await deliver(
      h,
      'proton.config_changed',
      configChanged('applications', false, false, ['retentionDays']),
    );

    expect((await h.application()).contentPurgeAt).toBe((accepted.decidedAt ?? 0) + 90 * DAY_MS);
    expect(h.scheduled).toEqual([]);
  });

  test('other saves leave the purge dates alone', async () => {
    const h = harness();
    await h.submit();
    const accepted = await h.accept();

    h.config = { ...h.config, retentionDays: 7 };
    await deliver(h, 'proton.config_changed', configChanged('applications', true, true, ['forms']));

    expect((await h.application()).contentPurgeAt).toBe(accepted.contentPurgeAt);
  });
});

describe('work a press queued', () => {
  test('is handed to the listener group rather than run inline', async () => {
    const h = harness();
    await h.submit();

    await requestWork(h.ctx, h.deps, APP_ID);

    expect(h.calls).toEqual([]);
    expect(h.scheduled).toEqual([]);
    expect(h.published).toEqual([
      {
        type: 'applications.work_requested',
        naturalKey: `${APP_ID}:${h.clock}`,
        payload: { guildId: GUILD, applicationId: APP_ID, reason: 'decision' },
      },
    ]);

    const [request] = h.published;
    await deliver(h, 'applications.work_requested', request?.payload ?? {});
    expect(h.effects().every((effect) => effect.status === 'succeeded')).toBe(true);
  });

  test('falls back to the sweep when the request can’t be published', async () => {
    const h = harness();
    h.ctx.publish = async () => {
      throw new Error('bus unavailable');
    };

    await requestWork(h.ctx, h.deps, APP_ID);

    const slot = wakeSlot(h.clock);
    expect(h.scheduled).toEqual([{ jobId: 'sweep', runAt: slot, naturalKey: `wake:${slot}` }]);
    expect(h.logs.some((log) => log.level === 'warn')).toBe(true);
  });

  test('falls back to the sweep when the context can’t publish at all', async () => {
    const h = harness();
    delete h.ctx.publish;

    await requestWork(h.ctx, h.deps, APP_ID);

    expect(h.scheduled).toHaveLength(1);
  });

  test('never throws, even when the sweep can’t be armed either', async () => {
    const h = harness();
    h.ctx.publish = async () => {
      throw new Error('bus unavailable');
    };
    h.ctx.schedule = async () => {
      throw new Error('scheduler unavailable');
    };

    await expect(requestWork(h.ctx, h.deps, APP_ID)).resolves.toBeUndefined();
    expect(h.logs.some((log) => log.level === 'error')).toBe(true);
  });
});

describe('work the api queued', () => {
  test('runs the named application’s effects', async () => {
    const h = harness();
    await h.submit();
    await deliver(h, 'applications.work_requested', {
      guildId: GUILD,
      applicationId: APP_ID,
      reason: 'decision',
    });

    expect(h.effects().every((effect) => effect.status === 'succeeded')).toBe(true);
  });

  test('ignores a request for another server', async () => {
    const h = harness();
    await h.submit();
    await deliver(h, 'applications.work_requested', {
      guildId: OTHER_GUILD,
      applicationId: APP_ID,
      reason: 'decision',
    });

    expect(h.calls).toEqual([]);
  });

  test('says what is missing when the module was built without its store', async () => {
    const h = harness();
    const { store: _store, ...unwired } = h.raw();
    await deliver(h, 'applications.work_requested', { guildId: GUILD, reason: 'retry' }, unwired);

    expect(h.logs.map((log) => log.message).join('\n')).toContain('store');
  });
});

describe('answers from other modules', () => {
  test('an XP answer for another module’s grant is ignored', async () => {
    const h = harness({}, { actions: { onAccept: { xp: 10 } } });
    await h.submit();
    await h.accept();
    await h.work(APP_ID);

    await deliver(h, 'xp.granted', {
      guildId: GUILD,
      userId: APPLICANT,
      grantId: `applications:${GUILD}:${APP_ID}:accepted`,
      sourceModule: 'achievements',
      status: 'granted',
      amount: 10,
    });
    expect(h.effect('accepted:xp').status).toBe('requested');

    await deliver(h, 'xp.granted', {
      guildId: GUILD,
      userId: APPLICANT,
      grantId: 'applications:somewhere-else',
      sourceModule: 'applications',
      status: 'granted',
      amount: 10,
    });
    expect(h.effect('accepted:xp').status).toBe('requested');
  });

  test('a ticket answer for another module is ignored', async () => {
    const h = harness({}, { interview: { ticketTypeId: 'interview' } });
    await h.submit();
    await h.openTicket();
    await h.work(APP_ID);
    const [ticket] = h.byKind('ticket');

    await deliver(h, 'tickets.open_answered', {
      guildId: GUILD,
      requestId: ticket?.id,
      sourceModule: 'appeals',
      sourceRef: APP_ID,
      status: 'opened',
      ticketId: 'ticket-1',
    });

    expect(h.byKind('ticket')[0]?.status).toBe('requested');
    expect((await h.application()).interviewTicketId).toBeNull();
  });

  test('every listener declares one event type', () => {
    const types = createApplicationsListeners({}).map((listener) => listener.types);
    expect(types).toEqual([
      ['proton.panel_requested'],
      ['proton.config_changed'],
      ['guild.available'],
      ['applications.work_requested'],
      ['xp.granted'],
      ['tickets.open_answered'],
    ]);
  });
});
