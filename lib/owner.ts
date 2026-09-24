/**
 * Whose data this is.
 *
 * The tools keep their work in the browser — a whole cut file does not belong
 * on a server, and a flow is typed too fast to wait for one. But a browser is
 * not a person: a team laptop is signed into by four debaters in a weekend,
 * and every one of them used to open the same library and the same flow.
 * So every name the tools store under carries the account it belongs to, and
 * signing in as someone else opens their things, not yours.
 *
 * Everything written before this existed was stored under the bare name. The
 * first account to open a tool afterwards takes that over — it is almost
 * certainly theirs — and the bare copy is removed, so the next account to
 * sign in on the same browser starts empty rather than inheriting it too.
 */

/** A storage name that belongs to one account. */
export const scoped = (base: string, owner?: string | null) => (owner ? `${base}:${owner}` : base);

/**
 * This account's value for a localStorage key, taking over the value stored
 * under the bare key if this account has none of its own yet.
 */
export function adoptLocal(base: string, owner?: string | null): string | null {
  try {
    const key = scoped(base, owner);
    const mine = localStorage.getItem(key);
    if (mine !== null || !owner) return mine;
    const old = localStorage.getItem(base);
    if (old === null) return null;
    localStorage.setItem(key, old);
    localStorage.removeItem(base);
    return old;
  } catch {
    return null;
  }
}
