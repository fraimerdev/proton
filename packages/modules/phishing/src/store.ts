export interface BlocklistStats {
  size: number;

  refreshedAt: Date | null;

  feeds: string[];

  failures: { url: string; reason: string }[];
}

export interface BlocklistInstall {
  domains: readonly string[];
  refreshedAt: Date;
  feeds: readonly string[];
  failures: readonly { url: string; reason: string }[];
}

export interface BlocklistStore {
  replace(install: BlocklistInstall): Promise<number>;

  lookup(candidates: readonly string[]): Promise<string | null>;

  stats(): Promise<BlocklistStats>;
}
