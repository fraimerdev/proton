export class HttpGuildRegistrar {
  readonly #baseUrl: string;
  readonly #secret: string;

  constructor(baseUrl: string, secret: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#secret = secret;
  }

  async ensure(
    guildId: string,
    name: string,
    extra: { locale?: string; shardId?: number } = {},
  ): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/guilds/${guildId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-proton-secret': this.#secret },
      body: JSON.stringify({ name, ...extra }),
    });

    if (!response.ok) {
      throw new Error(`could not register guild ${guildId}: api returned ${response.status}`);
    }
  }

  async markLeft(guildId: string): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/guilds/${guildId}`, {
      method: 'DELETE',
      headers: { 'x-proton-secret': this.#secret },
    });

    if (!response.ok) {
      throw new Error(`could not mark guild ${guildId} as left: api returned ${response.status}`);
    }
  }
}
