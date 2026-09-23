import { cookies } from "next/headers";

/**
 * The admin key, held as a cookie.
 *
 * The pool controls take the key with every request, which is right for one
 * button pressed twice a weekend. The tools are different: they are whole
 * workbenches, opened and worked in for an hour at a time, and retyping a
 * password to reach each one would only teach the habit of keeping it in a
 * text file.
 *
 * So unlocking sets a cookie and the tools read it. It is httpOnly, which
 * means the key never reaches the page's own JavaScript and cannot be read
 * out of the browser by anything running there. A second, readable cookie
 * carries no secret and exists only so the nav knows whether to show the
 * link — being wrong about that is a cosmetic mistake, not a security one.
 */

export const ADMIN_COOKIE = "break_admin";
export const ADMIN_HINT = "break_admin_on";
const MONTH = 60 * 60 * 24 * 30;

export function adminKeyOk(key: string): boolean {
  const want = process.env.ADMIN_KEY;
  return !!want && !!key && key === want;
}

/** Is this request carrying a valid admin key? Server components and routes. */
export function isAdmin(): boolean {
  try {
    return adminKeyOk(cookies().get(ADMIN_COOKIE)?.value || "");
  } catch {
    return false;                       // called outside a request
  }
}

export const adminCookie = (value: string) => ({
  name: ADMIN_COOKIE,
  value,
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: value ? MONTH : 0,
});

export const hintCookie = (on: boolean) => ({
  name: ADMIN_HINT,
  value: on ? "1" : "",
  httpOnly: false,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: on ? MONTH : 0,
});
