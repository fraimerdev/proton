import {
  type AssetKind,
  acceptImage,
  BRANDING_MODULE_ID,
  type BrandingAssetStore,
} from '@proton/module-branding';
import type { ModuleConfigService } from '../modules/service.ts';

export class BrandingAssetError extends Error {
  readonly code: 'rejected_image' | 'unknown_asset';

  constructor(code: 'rejected_image' | 'unknown_asset', message: string) {
    super(message);
    this.code = code;
    this.name = 'BrandingAssetError';
  }
}

export interface UploadAssetInput {
  guildId: string;
  kind: AssetKind;
  bytes: Uint8Array;
  actorId: string;
}

export interface ServedAsset {
  contentType: string;
  bytes: Uint8Array;
}

const HASH_KEY: Record<AssetKind, 'avatarHash' | 'bannerHash'> = {
  avatar: 'avatarHash',
  banner: 'bannerHash',
};

export class BrandingAssetService {
  readonly #assets: BrandingAssetStore;
  readonly #modules: ModuleConfigService;

  constructor(assets: BrandingAssetStore, modules: ModuleConfigService) {
    this.#assets = assets;
    this.#modules = modules;
  }

  // The bytes and the config hash are written together, and the hash goes through the ordinary
  // config path on purpose: that is what writes the audit row and publishes config_changed, which
  // is what makes the worker push the new picture. An upload that only wrote bytes would be silent
  // and unattributed.
  async upload(input: UploadAssetInput): Promise<{ hash: string }> {
    const checked = acceptImage(input.bytes, input.kind);
    if ('refused' in checked) {
      throw new BrandingAssetError(
        'rejected_image',
        `That image was not saved: ${checked.refused}`,
      );
    }

    await this.#assets.put(input.guildId, { kind: input.kind, ...checked.accepted }, input.actorId);

    await this.#writeHash(input.guildId, input.kind, checked.accepted.hash, input.actorId);

    return { hash: checked.accepted.hash };
  }

  async clear(guildId: string, kind: AssetKind, actorId: string): Promise<void> {
    await this.#assets.remove(guildId, kind);
    await this.#writeHash(guildId, kind, undefined, actorId);
  }

  async read(guildId: string, kind: AssetKind): Promise<ServedAsset> {
    const asset = await this.#assets.get(guildId, kind);
    if (!asset) {
      throw new BrandingAssetError('unknown_asset', `This server has no ${kind} saved.`);
    }

    return { contentType: asset.contentType, bytes: Buffer.from(asset.base64, 'base64') };
  }

  async #writeHash(
    guildId: string,
    kind: AssetKind,
    hash: string | undefined,
    actorId: string,
  ): Promise<void> {
    const before = await this.#modules.get(guildId, BRANDING_MODULE_ID);

    await this.#modules.update({
      guildId,
      moduleId: BRANDING_MODULE_ID,
      actorId,
      source: 'dashboard',
      config: { ...before.config, [HASH_KEY[kind]]: hash },
    });
  }
}
