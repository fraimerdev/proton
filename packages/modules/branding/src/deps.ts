import type { BrandingNameStyleStore, RestProxyClient } from '@proton/core';
import type { BrandingAssetStore, BrandingRoleStore } from './store.ts';

export interface BrandingDeps {
  assets?: BrandingAssetStore;

  roles?: BrandingRoleStore;

  nameStyles?: BrandingNameStyleStore;

  rest?: RestProxyClient;

  botUserId?: string;

  applicationId?: string;
}

export function describeUnbound(deps: BrandingDeps): string[] {
  const missing: string[] = [];

  if (!deps.assets) {
    missing.push('no asset store is bound, so the avatar and banner cannot be read');
  }

  if (!deps.roles) {
    missing.push(
      'no role store is bound, so the colour role an earlier Proton made cannot be found and deleted',
    );
  }

  if (!deps.nameStyles) {
    missing.push('no name style store is bound, so the display name style cannot be applied');
  }

  if (!deps.rest) {
    missing.push(
      'no REST client is bound, so Proton cannot read its display name style back from Discord',
    );
  }

  if (!deps.botUserId) {
    missing.push(
      "the bot's own user id is not bound, so Proton cannot tell what it already looks like here",
    );
  }

  return missing;
}
