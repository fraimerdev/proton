import { CUSTOM_ID_SEPARATOR } from '../interactions/custom-id.ts';
import { MESSAGE_CONTENT_MAX } from '../interactions/respond.ts';
import type { ActionRow, MessageButton } from '../messages/components.ts';
import type { ProtonMessage } from '../messages/message.ts';
import type { ContainerChild, V2Component } from '../messages/v2.ts';
import { V2_COMPONENTS_MAX } from '../messages/v2.ts';

export const SIMULATION_ACTOR = 'proton:simulation';

export const SIMULATION_MODULE_ID = 'simulation';

const SILENT = { everyone: false, roles: false, users: false } as const;

function inertButton(button: MessageButton): MessageButton {
  // A link button stays live: it carries no custom id, so pressing it opens the address it always
  // would rather than reaching a handler that is not listening.
  return button.style === 'link' ? button : { ...button, disabled: true };
}

function inertRow(row: ActionRow): ActionRow {
  return row.kind === 'buttons'
    ? { ...row, buttons: row.buttons.map(inertButton) }
    : { ...row, select: { ...row.select, disabled: true } };
}

function inertChild(child: ContainerChild): ContainerChild {
  if (child.kind === 'row') return { kind: 'row', row: inertRow(child.row) };

  if (child.kind === 'section' && child.accessory.kind === 'button') {
    return {
      ...child,
      accessory: { kind: 'button', button: inertButton(child.accessory.button) },
    };
  }

  return child;
}

function inertComponent(component: V2Component): V2Component {
  if (component.kind === 'container') {
    return { ...component, children: component.children.map(inertChild) };
  }

  return inertChild(component) as V2Component;
}

/**
 * Every non-link button and select still needs a custom id — Discord refuses one without, disabled
 * or not — so a test delivery gives them one namespaced to a module that does not exist. No
 * listener claims it, and the component is disabled besides, so the id is never carried anywhere.
 */
export const testCustomIdFor = (key: string): string =>
  `${SIMULATION_MODULE_ID}${CUSTOM_ID_SEPARATOR}inert${CUSTOM_ID_SEPARATOR}${key}`.slice(0, 100);

export function markerFor(actorId: string, interactive: boolean): string {
  const buttons = interactive ? ', and its buttons do nothing' : '';

  return `-# Test message sent by <@${actorId}> from the Proton dashboard. Nobody was pinged${buttons}.`;
}

export interface TestDeliveryResult {
  message: ProtonMessage;
  /** Set when the marker had to be left off, so the caller can say so rather than stay quiet. */
  markerOmitted: string | undefined;
}

/**
 * The configured message as it will really be posted, minus the three things a test must never do:
 * ping anybody, answer a press, or arrive looking like the real event. The marker is Discord
 * subtext, which is the smallest visible change that still identifies the message.
 */
export function asTestDelivery(message: ProtonMessage, actorId: string): TestDeliveryResult {
  const interactive =
    message.components.length > 0 ||
    message.v2.some(
      (component) =>
        component.kind === 'row' ||
        component.kind === 'section' ||
        (component.kind === 'container' &&
          component.children.some((child) => child.kind === 'row' || child.kind === 'section')),
    );

  const marker = markerFor(actorId, interactive);

  const base: ProtonMessage = {
    ...message,
    mentions: { ...SILENT },
    components: message.components.map(inertRow),
    v2: message.v2.map(inertComponent),
  };

  if (base.v2.length > 0) {
    if (base.v2.length >= V2_COMPONENTS_MAX) {
      return {
        message: base,
        markerOmitted:
          `this layout already uses all ${V2_COMPONENTS_MAX} components Discord allows, so the ` +
          'test message was sent without the line that marks it as a test.',
      };
    }

    return {
      message: { ...base, v2: [...base.v2, { kind: 'text', content: marker }] },
      markerOmitted: undefined,
    };
  }

  const content = base.content ?? '';
  const joined = content.trim() === '' ? marker : `${content}\n${marker}`;

  if (joined.length > MESSAGE_CONTENT_MAX) {
    return {
      message: base,
      markerOmitted:
        `this message already fills Discord's ${MESSAGE_CONTENT_MAX}-character limit, so the test ` +
        'message was sent without the line that marks it as a test.',
    };
  }

  return { message: { ...base, content: joined }, markerOmitted: undefined };
}
