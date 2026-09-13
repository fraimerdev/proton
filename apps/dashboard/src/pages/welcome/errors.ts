export interface ConfigErrors {
  /** The issue reported at exactly this config path. */
  at: (path: string) => string | undefined;
  /** The first issue reported at this path or anywhere below it, for a collapsed row. */
  under: (path: string) => string | undefined;
}
