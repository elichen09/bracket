/** next/link, for the desktop build: there is no Next router there, so a link is a link. */
import type { AnchorHTMLAttributes } from "react";

export default function Link({ href, prefetch: _p, replace: _r, scroll: _s, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; replace?: boolean; scroll?: boolean }) {
  return <a href={href} {...rest} />;
}
