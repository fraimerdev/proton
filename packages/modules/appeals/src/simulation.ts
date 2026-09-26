import type { SimulationAdapter, SimulationBuild, SimulationScene } from '@proton/core';
import { EMPTY_MESSAGE, readChoice, readInteger } from '@proton/core';
import type { AppealsConfig } from './config.ts';
import { decisionMessage } from './notify.ts';
import { APPEAL_DECISION_SURFACE, appealDecisionFacts } from './placeholders.ts';

const DECISIONS = ['approved', 'denied'] as const;

const DAY_MS = 86_400_000;

export const APPEALS_DECISION_SIMULATION: SimulationAdapter<AppealsConfig> = {
  descriptor: {
    id: 'appeals.decision',
    moduleId: 'appeals',
    label: 'Decision message',
    summary: 'The DM sent once an appeal is accepted or turned down.',
    surfaceId: APPEAL_DECISION_SURFACE.id,
    configPath: 'panels.*.approvedMessage',
    output: 'message',
    delivery: 'dm',
    subject: false,
    inputs: [
      {
        key: 'panelIndex',
        label: 'Appeal form',
        kind: 'integer',
        min: 0,
        max: 999,
        fallback: 0,
        fixed: true,
      },
      {
        key: 'decision',
        label: 'Decision',
        kind: 'choice',
        options: [
          { value: 'approved', label: 'Accepted' },
          { value: 'denied', label: 'Turned down' },
        ],
        fallback: 'approved',
      },
      { key: 'number', label: 'Appeal number', kind: 'integer', min: 1, max: 99_999, fallback: 7 },
    ],
    note:
      'Sent to you, since there’s no real appeal behind it. Nothing is filed, decided, unbanned or ' +
      'unblocked.',
  },

  build(config, scene: SimulationScene): SimulationBuild {
    const index = readInteger(scene.inputs, 'panelIndex', 0);
    const panel = config.panels[index];

    if (panel === undefined) {
      return {
        ok: false,
        humanReason:
          'that appeal form isn’t in this server’s settings any more. Reload the page and try again.',
        diagnostics: [],
      };
    }

    const status = readChoice(scene.inputs, 'decision', DECISIONS, 'approved');
    const number = readInteger(scene.inputs, 'number', 7);

    const facts = appealDecisionFacts(
      { number, status, filedAt: scene.now - 2 * DAY_MS, decidedAt: scene.now },
      { name: panel.name, ...(panel.rejoinUrl ? { rejoinUrl: panel.rejoinUrl } : {}) },
    );

    const lookup = APPEAL_DECISION_SURFACE.build(facts, { now: scene.now });
    const content = decisionMessage({ number, status }, panel, lookup, scene.now);

    return {
      ok: true,
      caption: `appeal #${number} on ${panel.name}, ${status === 'approved' ? 'accepted' : 'turned down'}`,
      diagnostics: [],
      output: {
        kind: 'message',
        // parse: [] on the real send too — a decision never pings anybody.
        message: {
          ...EMPTY_MESSAGE,
          content,
          mentions: { everyone: false, roles: false, users: false },
        },
        attachments: [],
      },
    };
  },
};

export const appealsSimulations: SimulationAdapter<AppealsConfig>[] = [APPEALS_DECISION_SIMULATION];
