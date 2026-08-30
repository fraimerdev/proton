const PAGE_SIZE = 200;
const MAX_PAGES = 250;

export interface BotGuild {
  id: string;
  name: string;
}

export interface BotGuildSource {
  guilds(): Promise<ReadonlyMap<string, string> | null>;
}

export interface BotGuildDirectoryOptions {
  ttlMs?: number;
  graceMs?: number;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  logger?: Pick<Console, 'warn'>;
}

interface Snapshot {
  guilds: ReadonlyMap<string, string>;
  at: number;
}

function isBotGuild(value: unknown): value is BotGuild {
  if (typeof value !== 'object' || value === null) return false;

  const guild = value as { id?: unknown; name?: unknown };
  return typeof guild.id === 'string' && typeof guild.name === 'string';
}

export class BotGuildDirectory implements BotGuildSource {
  readonly #baseUrl: string;
  readonly #ttlMs: number;
  readonly #graceMs: number;
  readonly #now: () => number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #logger: Pick<Console, 'warn'>;

  #snapshot: Snapshot | null = null;
  #refreshing: Promise<Snapshot | null> | null = null;

  constructor(restProxyUrl: string, options: BotGuildDirectoryOptions = {}) {
    this.#baseUrl = restProxyUrl.replace(/\/$/, '');
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#graceMs = options.graceMs ?? 600_000;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? console;
  }

  async guilds(): Promise<ReadonlyMap<string, string> | null> {
    const cached = this.#snapshot;
    if (cached && this.#now() - cached.at < this.#ttlMs) return cached.guilds;

    const refreshed = await this.#refresh();
    if (refreshed) return refreshed.guilds;

    // One failed call must not flip every card in every picker to "Proton is not in this server",
    // so the last good read keeps answering until it is old enough to be worth doubting.
    if (cached && this.#now() - cached.at < this.#graceMs) return cached.guilds;

    return null;
  }

  #refresh(): Promise<Snapshot | null> {
    this.#refreshing ??= this.#read()
      .then((guilds) => {
        const snapshot: Snapshot = { guilds, at: this.#now() };
        this.#snapshot = snapshot;
        return snapshot;
      })
      .catch((error: unknown) => {
        this.#logger.warn('Proton could not read its own server list from Discord:', error);
        return null;
      })
      .finally(() => {
        this.#refreshing = null;
      });

    return this.#refreshing;
  }

  async #read(): Promise<ReadonlyMap<string, string>> {
    const guilds = new Map<string, string>();
    let after: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (after !== undefined) query.set('after', after);

      // No x-proton-authorization header: the proxy signs with the bot token when that is absent,
      // and the question here is which guilds the bot is in, not which the signed-in admin is in.
      const response = await this.#fetch(
        `${this.#baseUrl}/api/users/@me/guilds?${query.toString()}`,
      );

      if (!response.ok) {
        throw new Error(
          `Discord answered ${response.status} when Proton asked which servers it is in.`,
        );
      }

      const body: unknown = await response.json();
      if (!Array.isArray(body)) {
        throw new Error('Discord answered the bot server list with something other than a list.');
      }

      for (const guild of body) {
        if (isBotGuild(guild)) guilds.set(guild.id, guild.name);
      }

      if (body.length < PAGE_SIZE) return guilds;

      const last = body.filter(isBotGuild).at(-1);
      if (!last) return guilds;

      after = last.id;
    }

    throw new Error(
      `Proton is in more than ${MAX_PAGES * PAGE_SIZE} servers, which this lookup cannot page through.`,
    );
  }
}
