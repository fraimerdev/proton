import type { ConfigProvider, ModuleConfigSnapshot } from './runtime.ts';

/**
 * Reads module config from the API service rather than the database.
 *
 * PLAN.md §9: the worker and the dashboard must share one definition of every
 * domain operation. Querying Postgres directly here would duplicate validation
 * and `schema_version` migration, and the two copies would drift.
 */
export class HttpConfigProvider implements ConfigProvider {
  readonly #baseUrl: string;
  readonly #secret: string;

  constructor(baseUrl: string, secret: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#secret = secret;
  }

  async get(guildId: string, moduleId: string): Promise<ModuleConfigSnapshot> {
    const response = await fetch(`${this.#baseUrl}/guilds/${guildId}/modules/${moduleId}`, {
      headers: { 'x-proton-secret': this.#secret },
    });

    if (!response.ok) {
      throw new Error(`api returned ${response.status} for ${moduleId} in ${guildId}`);
    }

    const body = (await response.json()) as { enabled: boolean; config: unknown };
    return { enabled: body.enabled, config: body.config };
  }
}
