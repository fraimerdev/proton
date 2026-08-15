/**
 * How a button or a dropdown option says which menu it belongs to and which
 * choice was made: `proton:rolemenu:<menuId>:<bindingKey>`.
 *
 * The namespace is load-bearing rather than decorative. `interaction.component`
 * is a single event type carrying *every* component press in the guild, and any
 * module that ever ships a button will be handed this module's presses and this
 * module handed theirs. A parser that accepted anything roughly id-shaped would
 * swallow another module's interaction — and the symptom is that other module
 * doing nothing, with no error raised anywhere, which is the failure §1 exists to
 * eliminate. So `parseCustomId` refuses everything it does not positively
 * recognise, and the handler treats a refusal as "not ours" and returns.
 */

export const CUSTOM_ID_SEPARATOR = ':';

export const CUSTOM_ID_PREFIX = `proton${CUSTOM_ID_SEPARATOR}rolemenu${CUSTOM_ID_SEPARATOR}`;

/**
 * The key segment a dropdown's own `custom_id` carries.
 *
 * A string select has one `custom_id` for the whole component and a `value` per
 * option, so there is no single binding key to name in it — the chosen keys
 * arrive in `data.values` instead. Rather than inventing a second grammar for
 * dropdowns, their id carries this sentinel in the key position, which keeps one
 * shape for every component this module emits. `'*'` because no emoji and no
 * sensible slug is a bare asterisk; `config.ts` refuses a binding key equal to it
 * anyway, so the two can never be confused.
 */
export const SELECT_BINDING_KEY = '*';

export interface RolemenuCustomId {
  menuId: string;
  bindingKey: string;
}

export function encodeCustomId(menuId: string, bindingKey: string): string {
  return `${CUSTOM_ID_PREFIX}${menuId}${CUSTOM_ID_SEPARATOR}${bindingKey}`;
}

/** Whether this id claims to be ours at all — the "is this mine?" question. */
export function hasRolemenuPrefix(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.startsWith(CUSTOM_ID_PREFIX);
}

/**
 * Read an id back, or `null` for anything that is not exactly one of ours.
 *
 * Deliberately strict about the segment count. A binding key cannot contain the
 * separator (`config.ts` refuses one that does), so a well-formed id has exactly
 * two segments after the prefix; anything else is either another module's id
 * that happens to share the prefix or a message written by a build whose grammar
 * differed, and guessing at either would attach a role to the wrong choice.
 *
 * Length is not checked here. Discord will not deliver a `custom_id` longer than
 * it accepted, and the 100-character ceiling is enforced where it can still be
 * acted on — on save, in `config.ts`, rather than under someone's finger.
 */
export function parseCustomId(raw: unknown): RolemenuCustomId | null {
  if (!hasRolemenuPrefix(raw)) return null;

  const segments = raw.slice(CUSTOM_ID_PREFIX.length).split(CUSTOM_ID_SEPARATOR);
  if (segments.length !== 2) return null;

  const [menuId, bindingKey] = segments;
  if (!menuId || !bindingKey) return null;

  return { menuId, bindingKey };
}
