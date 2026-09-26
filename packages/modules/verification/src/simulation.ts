import type { SimulationAdapter, SimulationBuild } from '@proton/core';
import { parseComponentEmoji } from '@proton/core';
import type { VerificationConfig } from './config.ts';

/**
 * The panel holds no placeholders — it is literal text an admin writes once and every joiner sees —
 * so this renders the stored message itself and adds the verify button the way buildPanelMessage
 * does. The button is disabled on a test delivery, so nobody verifies by pressing this copy.
 */
export const VERIFICATION_PANEL_SIMULATION: SimulationAdapter<VerificationConfig> = {
  descriptor: {
    id: 'verification.panel',
    moduleId: 'verification',
    label: 'Verification panel',
    summary: 'The message with the button members press to verify.',
    configPath: 'panel',
    output: 'message',
    delivery: 'channel',
    channelPath: 'panelChannelId',
    subject: false,
    inputs: [],
    note:
      'Posts a copy where you choose. The real panel isn’t changed, and the button on the copy ' +
      'doesn’t verify anyone.',
  },

  destination: (config) => config.panelChannelId ?? null,

  build(config): SimulationBuild {
    const emoji = parseComponentEmoji(config.panelButtonEmoji);

    return {
      ok: true,
      caption: 'the panel as a joiner sees it',
      diagnostics: [],
      output: {
        kind: 'message',
        message: {
          ...config.panel,
          components: [
            {
              kind: 'buttons',
              buttons: [
                {
                  key: 'verify',
                  style: config.panelButtonStyle,
                  label: config.panelButtonLabel,
                  ...(emoji ? { emoji } : {}),
                },
              ],
            },
          ],
        },
        attachments: [],
      },
    };
  },
};

export const verificationSimulations: SimulationAdapter<VerificationConfig>[] = [
  VERIFICATION_PANEL_SIMULATION,
];
