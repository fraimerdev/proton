import type { SimulationAdapter, SimulationBuild, SimulationScene } from '@proton/core';
import { readInteger } from '@proton/core';
import type { TempVcConfig } from './config.ts';
import { renderTempVcName, TEMPVC_NAME_SURFACE } from './placeholders.ts';

export const TEMPVC_NAME_SIMULATION: SimulationAdapter<TempVcConfig> = {
  descriptor: {
    id: 'tempvc.channel_name',
    moduleId: 'tempvc',
    label: 'Temporary channel name',
    summary: 'What a temporary channel will be called when someone joins this creator channel.',
    surfaceId: TEMPVC_NAME_SURFACE.id,
    configPath: 'hubs.*.nameTemplate',
    output: 'text',
    delivery: 'none',
    subject: true,
    inputs: [
      {
        key: 'hubIndex',
        label: 'Creator channel',
        kind: 'integer',
        min: 0,
        max: 999,
        fallback: 0,
        fixed: true,
      },
    ],
    note: 'No channel is created and no one is moved. This only works out the name.',
  },

  build(config, scene: SimulationScene): SimulationBuild {
    const index = readInteger(scene.inputs, 'hubIndex', 0);
    const hub = config.hubs[index];

    if (hub === undefined) {
      return {
        ok: false,
        humanReason:
          'that creator channel is no longer in this server’s settings. Reload and try again.',
        diagnostics: [],
      };
    }

    const { user, displayName } = scene.subject;
    const hubFacts = scene.guildState?.channels.get(hub.channelId);

    const rendered = renderTempVcName(
      hub.nameTemplate,
      {
        owner: {
          userId: user.id,
          displayName,
          username: user.username ?? displayName,
          globalName: user.globalName,
        },
        hub:
          hubFacts === undefined
            ? { id: hub.channelId }
            : {
                id: hub.channelId,
                name: hubFacts.name,
                type: hubFacts.type,
                parentId: hubFacts.parentId,
              },
        server: scene.server,
      },
      scene.now,
    );

    return {
      ok: true,
      caption: `${displayName} joining ${hubFacts?.name === undefined ? 'the creator channel' : `#${hubFacts.name}`}`,
      diagnostics: rendered.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: `hubs.${index}.nameTemplate`,
      })),
      output: { kind: 'text', text: rendered.output },
    };
  },
};

export const tempvcSimulations: SimulationAdapter<TempVcConfig>[] = [TEMPVC_NAME_SIMULATION];
