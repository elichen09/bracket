/**
 * coda's AI features, on Claude: the client, the key, and one way to ask.
 *
 * Each person pastes their own Anthropic API key (AI settings). It is kept in
 * this browser — or the desktop app — for their account alone, and every
 * request goes from here straight to Anthropic with it: coda's server never
 * sees the key or what is asked. So the SDK runs in the browser
 * (dangerouslyAllowBrowser): the key is the user's own, in their own browser,
 * which is the case that flag exists for.
 *
 * Claude Haiku 5.5, at low effort: the jobs are extraction and choosing —
 * a cite's parts, which phrases to underline, which block answers what —
 * where speed matters and depth doesn't. Every answer comes back as JSON in a
 * fixed shape (structured outputs), and the caller checks it against the card
 * before anything in the document changes.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { scoped } from "@/lib/owner";

export const AI_MODEL = "claude-haiku-5-5";

/* ------------------------------------------------------------------ the key */

const KEY = "coda.ai.key";

export function aiKey(owner?: string | null): string {
  try { return localStorage.getItem(scoped(KEY, owner)) || ""; } catch { return ""; }
}
export function setAiKey(owner: string | null | undefined, key: string | null) {
  try { if (key) localStorage.setItem(scoped(KEY, owner), key.trim()); else localStorage.removeItem(scoped(KEY, owner)); } catch { /* private */ }
}

/* ------------------------------------------------------------------ asking */

/** Something to say to the user, in words — not an SDK error. */
export class AiError extends Error {}

function client(key: string) {
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

/** What went wrong, as a sentence. Most specific first; anything unknown keeps its own message. */
function said(e: unknown): Error {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.APIUserAbortError || (e instanceof Error && e.name === "AbortError")) return new AiError("Stopped.");
  if (e instanceof Anthropic.AuthenticationError) return new AiError("Anthropic refused that API key — check it in AI settings.");
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError("That API key isn't allowed to use " + AI_MODEL + ".");
  if (e instanceof Anthropic.RateLimitError) return new AiError("Too many requests at once — give it a moment and try again.");
  if (e instanceof Anthropic.APIConnectionError) return new AiError("Can't reach Claude — check the internet connection.");
  if (e instanceof Anthropic.BadRequestError) {
    const m = e.message || "";
    return new AiError(/credit balance/i.test(m) ? "Your Anthropic account is out of credit — add some at console.anthropic.com." : "Claude couldn't take that request: " + m);
  }
  if (e instanceof Anthropic.APIError) return new AiError("Claude had a problem (" + (e.status ?? "?") + ") — try again.");
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * One question, answered as JSON in the given shape. Throws an AiError with a
 * sentence for the user when it can't be answered.
 */
export async function askJson<S extends z.ZodType>(key: string, prompt: string, shape: S, signal?: AbortSignal): Promise<z.infer<S>> {
  if (!key) throw new AiError("Add your Anthropic API key in AI settings first.");
  try {
    const res = await client(key).messages.parse(
      {
        model: AI_MODEL,
        max_tokens: 16000,
        output_config: { effort: "low", format: zodOutputFormat(shape) },
        messages: [{ role: "user", content: prompt }],
      },
      { signal },
    );
    if (res.stop_reason === "refusal") throw new AiError("Claude declined this one.");
    if (res.stop_reason === "max_tokens") throw new AiError("Claude's answer ran too long — try a shorter card.");
    if (res.parsed_output == null) throw new AiError("Claude's answer couldn't be read — try again.");
    return res.parsed_output as z.infer<S>;
  } catch (e) {
    throw said(e);
  }
}

/** Whether a key works: asks Anthropic about the model, which costs nothing. */
export async function checkKey(key: string): Promise<void> {
  try { await client(key).models.retrieve(AI_MODEL); } catch (e) { throw said(e); }
}
