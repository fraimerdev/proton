import type { SimulationAdapter, SimulationBuild, SimulationScene } from '@proton/core';
import { readInteger } from '@proton/core';
import type { CountersConfig } from './config.ts';
import { COUNTER_SURFACE, renderCounterName } from './placeholders.ts';

const NO_STATE =
  'Proton has not finished reading this server yet, so it cannot count anything. Try again in a ' +
  'moment — the count arrives with the first gateway connection after a restart.';

export const COUNTERS_NAME_SIMULATION: SimulationAdapter<CountersConfig> = {
  descriptor: {
    id: 'counters.channel_name',
    moduleId: 'counters',
    label: 'Counter channel name',
    summary: 'What a counter channel will be called at the next refresh.',
    surfaceId: COUNTER_SURFACE.id,
    configPath: 'counters.*.template',
    output: 'text',
    delivery: 'none',
    // Nobody to stand in for: a counter counts the server, not a member.
    subject: false,
    inputs: [
      {
        key: 'counterIndex',
        label: 'Counter',
        kind: 'integer',
        min: 0,
        max: 999,
        fallback: 0,
        fixed: true,
      },
    ],
    note:
      'Counted against this server as it is right now. No channel is created or renamed — the ' +
      'refresh that does that runs every ten minutes.',
  },

  build(config, scene: SimulationScene): SimulationBuild {
    const index = readInteger(scene.inputs, 'counterIndex', 0);
    const counter = config.counters[index];

    if (counter === undefined) {
      return {
        ok: false,
        humanReason: 'that counter is no longer in this server’s settings. Reload and try again.',
        diagnostics: [],
      };
    }

    if (scene.guildState === null) {
      return { ok: false, humanReason: NO_STATE, diagnostics: [] };
    }

    const rendered = renderCounterName(
      counter.template,
      { source: counter.source, state: scene.guildState },
      scene.now,
    );

    return {
      ok: true,
      caption: `${scene.server?.name ?? 'this server'}, counting ${counter.source}`,
      diagnostics: rendered.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: `counters.${index}.template`,
      })),
      output: { kind: 'text', text: rendered.output },
    };
  },
};

export const countersSimulations: SimulationAdapter<CountersConfig>[] = [COUNTERS_NAME_SIMULATION];
