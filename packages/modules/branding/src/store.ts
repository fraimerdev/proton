import type { DbHandle } from '@proton/db';
import { and, eq } from 'drizzle-orm';
import type { AssetKind } from './kinds.ts';
import { brandingAssets, brandingRoles } from './table.ts';

export interface BrandingAsset {
  kind: AssetKind;
  contentType: string;
  base64: string;
  hash: string;
  byteSize: number;
}

export interface BrandingAssetStore {
  get(guildId: string, kind: AssetKind): Promise<BrandingAsset | null>;

  put(guildId: string, asset: BrandingAsset, uploadedBy: string | null): Promise<void>;

  remove(guildId: string, kind: AssetKind): Promise<void>;
}

export class DrizzleBrandingAssetStore implements BrandingAssetStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  get #db() {
    return this.#handle.db;
  }

  async get(guildId: string, kind: AssetKind): Promise<BrandingAsset | null> {
    const [row] = await this.#db
      .select({
        contentType: brandingAssets.contentType,
        base64: brandingAssets.base64,
        hash: brandingAssets.hash,
        byteSize: brandingAssets.byteSize,
      })
      .from(brandingAssets)
      .where(and(eq(brandingAssets.guildId, guildId), eq(brandingAssets.kind, kind)))
      .limit(1);

    return row ? { kind, ...row } : null;
  }

  async put(guildId: string, asset: BrandingAsset, uploadedBy: string | null): Promise<void> {
    await this.#db
      .insert(brandingAssets)
      .values({
        guildId,
        kind: asset.kind,
        contentType: asset.contentType,
        base64: asset.base64,
        hash: asset.hash,
        byteSize: asset.byteSize,
        uploadedBy,
      })
      .onConflictDoUpdate({
        target: [brandingAssets.guildId, brandingAssets.kind],
        set: {
          contentType: asset.contentType,
          base64: asset.base64,
          hash: asset.hash,
          byteSize: asset.byteSize,
          uploadedBy,
          uploadedAt: new Date(),
        },
      });
  }

  async remove(guildId: string, kind: AssetKind): Promise<void> {
    await this.#db
      .delete(brandingAssets)
      .where(and(eq(brandingAssets.guildId, guildId), eq(brandingAssets.kind, kind)));
  }
}

export interface BrandingRoleStore {
  get(guildId: string): Promise<string | null>;

  put(guildId: string, roleId: string): Promise<void>;

  forget(guildId: string): Promise<void>;
}

export class DrizzleBrandingRoleStore implements BrandingRoleStore {
  readonly #handle: DbHandle;

  constructor(handle: DbHandle) {
    this.#handle = handle;
  }

  get #db() {
    return this.#handle.db;
  }

  async get(guildId: string): Promise<string | null> {
    const [row] = await this.#db
      .select({ roleId: brandingRoles.roleId })
      .from(brandingRoles)
      .where(eq(brandingRoles.guildId, guildId))
      .limit(1);

    return row?.roleId ?? null;
  }

  async put(guildId: string, roleId: string): Promise<void> {
    await this.#db
      .insert(brandingRoles)
      .values({ guildId, roleId })
      .onConflictDoUpdate({ target: brandingRoles.guildId, set: { roleId } });
  }

  async forget(guildId: string): Promise<void> {
    await this.#db.delete(brandingRoles).where(eq(brandingRoles.guildId, guildId));
  }
}
