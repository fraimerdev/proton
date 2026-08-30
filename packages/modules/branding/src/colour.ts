import {
  HOLOGRAPHIC_PRIMARY,
  HOLOGRAPHIC_SECONDARY,
  HOLOGRAPHIC_TERTIARY,
  type RoleColours,
} from '@proton/core';
import type { BrandingConfig } from './config.ts';

export type NameEffect = BrandingConfig['nameEffect'];

export const ROLE_NAME = 'Proton';

// Discord takes the whole holographic look or none of it, so the two colour pickers are ignored
// for that effect rather than being sent and refused.
export function coloursFor(config: BrandingConfig): RoleColours | null {
  switch (config.nameEffect) {
    case 'none':
      return null;

    case 'solid':
      return { primaryColor: config.primaryColor, secondaryColor: null, tertiaryColor: null };

    case 'gradient':
      return {
        primaryColor: config.primaryColor,
        secondaryColor: config.secondaryColor,
        tertiaryColor: null,
      };

    case 'holographic':
      return {
        primaryColor: HOLOGRAPHIC_PRIMARY,
        secondaryColor: HOLOGRAPHIC_SECONDARY,
        tertiaryColor: HOLOGRAPHIC_TERTIARY,
      };
  }
}

export function colourFingerprint(colours: RoleColours | null): string {
  if (!colours) return 'none';

  return [colours.primaryColor, colours.secondaryColor ?? '-', colours.tertiaryColor ?? '-'].join(
    ':',
  );
}

// Discord's own wording is "Enhanced Role Colours", and the refusal comes back as a flat 400 with
// no field named, so the sentence has to supply the context the API does not.
export const ENHANCED_COLOURS_HINT =
  'a gradient or holographic name needs this server to have Discord’s Enhanced Role Colours ' +
  'feature. Pick Solid instead, or boost the server until Discord grants it.';

export function describeColourFailure(effect: NameEffect, humanReason: string): string {
  const needsFeature = effect === 'gradient' || effect === 'holographic';

  return needsFeature ? `${humanReason} If it was refused, ${ENHANCED_COLOURS_HINT}` : humanReason;
}
