import type { BrandingAssetStore, BrandingRoleStore } from './store.ts';

export interface BrandingDeps {
  assets?: BrandingAssetStore;

  roles?: BrandingRoleStore;

  botUserId?: string;

  applicationId?: string;
}

export function describeUnbound(deps: BrandingDeps): string[] {
  const missing: string[] = [];

  if (!deps.assets) {
    missing.push('no asset store is bound, so the avatar and banner cannot be read');
  }

  if (!deps.roles) {
    missing.push('no role store is bound, so a coloured name cannot be kept between restarts');
  }

  if (!deps.botUserId) {
    missing.push(
      "the bot's own user id is not bound, so Proton cannot tell what it already looks like here",
    );
  }

  return missing;
}
