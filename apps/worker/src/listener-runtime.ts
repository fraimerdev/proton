import type {
  ActionExecutor,
  EventBus,
  EventType,
  Logger,
  ModuleContext,
  ModuleManifest,
  ModuleRegistry,
  ProtonEvent,
  Subscription,
} from '@proton/core';
import { ConfigUnavailableError } from './config-provider.ts';
import type { ModulePublisherFactory } from './module-publish.ts';
import type { ConfigProvider } from './runtime.ts';

/** Group name for a module's listener subscription. One group per module. */
export const LISTENER_GROUP_PREFIX = 'listener';

export const listenerGroup = (prefix: string, moduleId: string): string => `${prefix}:${moduleId}`;

export interface ListenerRuntimeDeps {
  bus: EventBus;
  registry: ModuleRegistry;
  executor: ActionExecutor;
  config: ConfigProvider;
  logger: Logger;
  /** Overridable so a test can isolate its groups from a shared Redis. */
  groupPrefix?: string;
  /**
   * Builds the `publish` a module receives, bound to its id and guild.
   *
   * Optional so a test can run listeners without a bus. A module that declares
   * `emits` and is run without this gets `ctx.publish` undefined, which its own
   * code has to tolerate — the same posture every other injected port takes.
   */
  publisherFor?: ModulePublisherFactory;
}

/** The event types one manifest's listeners collectively care about. */
export function subscribedTypes(manifest: ModuleManifest): EventType[] {
  return [...new Set((manifest.listeners ?? []).flatMap((listener) => listener.types))];
}

/**
 * Drives `manifest.listeners` — the half of the module contract that had never
 * been connected to anything.
 *
 * A sibling of `ModuleRuntime` rather than a branch inside it. The command path
 * binds a channel-scoped executor and consults the `permissions` module's
 * override gate; the listener path does neither, for reasons written below. One
 * class doing both would be a method with two disjoint halves and a boolean.
 *
 * Four decisions are worth stating outright, because each has a plausible-looking
 * alternative that is wrong:
 *
 *  1. **One consumer group per module**, not one shared subscription over the
 *     union of every type. The bus's only unit of acknowledgement is
 *     `(group, entry)`: a handler that throws leaves the entry unacked so it is
 *     redelivered (deliberately — Gate 0's kill-the-worker criterion depends on
 *     it). Under a shared group, one module throwing would redeliver the event to
 *     *every* module on that subscription, up to `maxDeliveries` times, and then
 *     dead-letter it for all of them. Per-module groups mean a failing module
 *     retries alone. The cost is one Redis connection per listening module.
 *
 *  2. **No permissions override gate.** `permissions` gates who may *invoke* a
 *     command. A listener is a reaction to something that already happened, there
 *     is no invoker to refuse and no interaction to refuse them with, and running
 *     the gate would mean a second config read per event to answer a question
 *     nobody asked.
 *
 *  3. **The base executor, never `.scoped()`.** A listener has no
 *     `app_permissions` — Discord only computes that for interactions — and it
 *     frequently acts on a channel other than the event's, as phishing does when
 *     it alerts a staff channel about a message elsewhere. Binding the event's
 *     channel would compute the precheck against the wrong channel, which is
 *     worse than computing it at guild level. The trade is real and recorded: a
 *     channel overwrite denying the bot SEND_MESSAGES surfaces as Discord's 403
 *     rather than as a named precheck failure. `antinuke`'s `announce` documents
 *     the same trade from the module side.
 *
 *  4. **A permanent config failure acks.** See `#snapshot`.
 */
export class ModuleListenerRuntime {
  readonly #deps: ListenerRuntimeDeps;
  readonly #prefix: string;

  constructor(deps: ListenerRuntimeDeps) {
    this.#deps = deps;
    this.#prefix = deps.groupPrefix ?? LISTENER_GROUP_PREFIX;
  }

  /** Manifests that actually declare a listener with at least one live type. */
  listening(): ModuleManifest[] {
    return this.#deps.registry.all().filter((manifest) => subscribedTypes(manifest).length > 0);
  }

  /**
   * Subscribe every listening module, one group each.
   *
   * New groups start at `'$'`. The streams are never trimmed, so a group created
   * at `'0'` would replay the entire retained history the first time a module is
   * deployed — and any entry older than the executor's dedupe TTL is not deduped
   * but *re-executed*. The first thing a freshly deployed anti-nuke would do is
   * work through a backlog of long-settled deletions and start stripping roles.
   *
   * `'$'` applies only to group *creation*. On restart the group already exists,
   * `#ensureGroups` swallows BUSYGROUP, and consumption resumes from the group's
   * own cursor — so events published while the worker was down are still
   * delivered, and nothing is lost to a deploy. The one gap is inherent and
   * intended: on the very first deploy of a module, events published in the
   * milliseconds between this process starting and its groups existing are not
   * seen. They predate the module, which is the outcome `'$'` is chosen for.
   */
  start(): Subscription[] {
    return this.listening().map((manifest) => {
      const types = subscribedTypes(manifest);

      this.#deps.logger.info(`listening for ${manifest.id}`, {
        moduleId: manifest.id,
        types: types.join(', '),
      });

      return this.#deps.bus.subscribe(
        listenerGroup(this.#prefix, manifest.id),
        types,
        (event) => this.handleFor(manifest, event),
        { startId: '$' },
      );
    });
  }

  /**
   * Run one module's matching listeners against one event.
   *
   * A handler that throws propagates, deliberately: the bus leaves the entry
   * unacknowledged so it is redelivered, and every action a module takes carries
   * an idempotency key derived from `event.id` (I4), which makes that redelivery
   * harmless. Swallowing here would turn an at-least-once bus into an
   * at-most-once one and lose events silently.
   */
  async handleFor(manifest: ModuleManifest, event: ProtonEvent): Promise<void> {
    // `event.guildId`, never `payload.guild_id`. The normaliser already decided
    // what the guild is for each dispatch shape, and re-deriving it here would be
    // a second place to get it wrong.
    if (event.guildId === null) {
      // A DM. There is no per-guild config that could apply and no moderator to
      // act for, so this is ordinary, not a fault.
      return;
    }
    const guildId = event.guildId;

    const matching = (manifest.listeners ?? []).filter((listener) =>
      listener.types.includes(event.type),
    );
    if (matching.length === 0) return;

    const snapshot = await this.#snapshot(guildId, manifest, event);
    if (snapshot === null) return;

    // No log line for the disabled case. A module is disabled in far more guilds
    // than it is enabled, and `message.created` fires per message — one line each
    // is not observability, it is a way to make the log unreadable.
    if (!snapshot.enabled) return;

    // Validated on every read (I5). The stored JSONB is never handed to a module
    // unchecked, even though the API validated it on write.
    const parsed = manifest.configSchema.safeParse(snapshot.config);
    if (!parsed.success) {
      this.#deps.logger.error(`invalid stored config for ${manifest.id}, so it did not run`, {
        guildId,
        moduleId: manifest.id,
        eventType: event.type,
        issues: parsed.error.issues.map((i) => `${i.path.map(String).join('.')} ${i.message}`),
      });
      return;
    }

    // Typed off the parse result rather than annotated `ModuleContext<unknown>`:
    // a listener is declared as `EventListener<z.infer<C>>`, so the context has
    // to carry the module's own config type for the handler to accept it.
    const ctx: ModuleContext<typeof parsed.data> = {
      guildId,
      config: parsed.data,
      executor: this.#deps.executor,
      logger: this.#deps.logger,
      // Bound to this module and this guild, so the allowlist check and the
      // guild stamp are not things a module author can forget (I3).
      ...(this.#deps.publisherFor
        ? { publish: this.#deps.publisherFor(manifest.id, guildId) }
        : {}),
    };

    // Sequential, not concurrent. A module's own listeners may well touch the
    // same state — anti-nuke's counter, verification's quarantine record — and
    // interleaving them would introduce a race inside a single module for no
    // gain, since separate modules already run in separate groups.
    for (const listener of matching) {
      await listener.handler(event, ctx);
    }
  }

  /**
   * Read the module's config, deciding for ourselves whether a failure is worth
   * retrying.
   *
   * Returning `null` means "give up on this event and let it be acked". That is
   * reserved for a *permanent* failure: `apps/api` answers 404 for a module it
   * does not know and 400 for a stored config that no longer parses, and both
   * will say exactly the same thing on every retry. Rethrowing them would leave
   * the entry unacked, burn all five deliveries at one per `claimIdleMs`, and
   * then dead-letter that guild's events for that module — permanently, and
   * without ever naming the guild. So it is logged loudly and dropped.
   *
   * Anything transient — a 5xx, a dropped connection, the API restarting —
   * rethrows, which is what redelivery is for.
   */
  async #snapshot(
    guildId: string,
    manifest: ModuleManifest,
    event: ProtonEvent,
  ): Promise<{ enabled: boolean; config: unknown } | null> {
    try {
      return await this.#deps.config.get(guildId, manifest.id);
    } catch (error) {
      if (error instanceof ConfigUnavailableError && error.permanent) {
        this.#deps.logger.error(
          `${manifest.id} did not run in this server because its configuration could not be ` +
            `read, and retrying will not help: ${error.message}. Open the module's settings in ` +
            'the Proton dashboard and save them once to rewrite the stored config.',
          {
            guildId,
            moduleId: manifest.id,
            status: error.status,
            eventType: event.type,
            eventId: event.id,
          },
        );
        return null;
      }
      throw error;
    }
  }
}
