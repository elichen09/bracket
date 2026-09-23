/**
 * The bit of Evidence that answers back.
 *
 * Two things a stylesheet cannot do on its own: draw a ripple from the point
 * the pointer actually landed on, and carry a card across the window from the
 * row you pressed to the list it landed in. Both are here, and both are pure
 * feedback — nothing in this file changes what the tool does, and the tool
 * works with it removed.
 *
 * It listens on the tool's root rather than on the controls themselves,
 * because the engine rewrites its own HTML constantly and anything bound to
 * an element would be thrown away with the next render.
 *
 * Anyone who has asked their system for less movement gets none of it: the
 * check is made per event rather than once, so changing the setting takes
 * effect without a reload.
 */

/** Controls big enough for a ripple to read as a ripple. */
const RIPPLED = ".btn, .docbar .fbtn, .tabs button, .tick, .mv, .row, .arg, .grp";

/** A card's flight, and the ripple, are the same length. */
const FLIGHT = 520;

export function polish(root: HTMLElement): () => void {
  const quiet = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Where the last press landed, for a card sent with the mouse. A card sent
  // with the return key has no press, so the selected row answers for it.
  let pressed: DOMRect | null = null;

  const ripple = (host: HTMLElement, x: number, y: number) => {
    const box = host.getBoundingClientRect();
    if (!box.width) return;
    const dot = document.createElement("span");
    dot.className = "rip";
    dot.style.left = `${x - box.left}px`;
    dot.style.top = `${y - box.top}px`;
    host.appendChild(dot);
    // Far enough to cover the control from wherever it started.
    const far = Math.max(box.width, box.height) * 1.5;
    const run = dot.animate(
      [{ transform: "scale(0)", opacity: 0.22 }, { transform: `scale(${far / 6})`, opacity: 0 }],
      { duration: FLIGHT, easing: "cubic-bezier(.22,1,.36,1)" },
    );
    run.onfinish = () => dot.remove();
    run.oncancel = () => dot.remove();
  };

  const down = (ev: PointerEvent) => {
    const target = ev.target as HTMLElement | null;
    if (!target?.closest) return;
    const row = target.closest<HTMLElement>(".row, .arg");
    if (row) pressed = row.getBoundingClientRect();
    if (quiet() || ev.button !== 0) return;
    const hit = target.closest<HTMLElement>(RIPPLED);
    if (hit && !hit.hasAttribute("disabled")) ripple(hit, ev.clientX, ev.clientY);
  };

  /**
   * A card has been sent: bump the count it was added to, and fly the thing
   * that was sent into it. The engine fires this after the side list has been
   * redrawn and before the search is cleared, so the row is still on screen.
   */
  const sent = (ev: Event) => {
    const count = root.querySelector<HTMLElement>("#sendCount");
    if (count) {
      count.classList.remove("bump");
      void count.offsetWidth;             // so a second send replays it
      count.classList.add("bump");
    }
    if (quiet()) return;

    const tab = root.querySelector<HTMLElement>('.tabs button[data-tab="send"]');
    const from = root.querySelector<HTMLElement>(".row.sel")?.getBoundingClientRect() || pressed;
    if (!tab || !from) return;
    const to = tab.getBoundingClientRect();

    const chip = document.createElement("div");
    chip.className = "fly";
    chip.textContent = String((ev as CustomEvent).detail?.title || "sent");
    const width = Math.min(from.width, 300);
    chip.style.left = `${from.left}px`;
    chip.style.top = `${from.top}px`;
    chip.style.width = `${width}px`;
    root.appendChild(chip);

    const dx = to.left + to.width / 2 - (from.left + width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const run = chip.animate([
      { transform: "translate(0,0) scale(1)", opacity: 1 },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.3}px) scale(.74)`, opacity: .92, offset: .55 },
      { transform: `translate(${dx}px, ${dy}px) scale(.2)`, opacity: 0 },
    ], { duration: FLIGHT, easing: "cubic-bezier(.4,0,.2,1)" });
    run.onfinish = () => chip.remove();
    run.oncancel = () => chip.remove();
  };

  root.addEventListener("pointerdown", down, true);
  root.addEventListener("evi:sent", sent);
  return () => {
    root.removeEventListener("pointerdown", down, true);
    root.removeEventListener("evi:sent", sent);
    root.querySelectorAll(".rip, .fly").forEach((n) => n.remove());
  };
}
