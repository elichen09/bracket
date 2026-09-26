/**
 * Rehighlighting a card in someone else's document.
 *
 * The other team's card, read your way: every highlight it came with turns
 * grey — still there, so anyone can see what they read — and you highlight
 * over it in green, the words that actually matter. Then the card goes to
 * your send doc as it now is.
 *
 * All of it happens in the rendered document, in place. A card is its tag
 * (a Heading 4) and everything under it down to the next heading, as readDoc
 * found it. Green is kept in spans of its own (`data-rh`) that hold nothing but
 * text, so taking some of it off again is a matter of cutting one span in
 * three.
 */
import { levelOf } from "./doc";

export const GREY = "#c0c0c0";      // Word's Gray-25%, the rehighlighter's grey
export const GREEN = "#00ff00";     // Word's bright green

const BLOCKS = "h1, h2, h3, h4, h5, h6, p, li";

export interface Card {
  tag: HTMLElement;
  els: HTMLElement[];               // the tag first, then its cite and text
  title: string;                    // the tag's words
  block: string;                    // the block it sits under, or ""
}

const words = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim();

/** The document's paragraphs and headings, outermost only (a list item's own paragraph is not counted twice). */
function paragraphs(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(BLOCKS)).filter((el) => !el.parentElement?.closest(BLOCKS));
}

/** The card a point in the document belongs to — or null, if it is not in one. */
export function cardAt(root: HTMLElement, target: Node | null): Card | null {
  if (!target) return null;
  const all = paragraphs(root);
  const at = all.findIndex((el) => el === target || el.contains(target));
  if (at < 0) return null;
  // back to the heading this sits under: a tag makes it a card, anything bigger does not
  let t = at;
  while (t >= 0 && !all[t].classList.contains("dv-head")) t--;
  if (t < 0 || levelOf(all[t]) !== 4) return null;
  const els = [all[t]];
  for (let i = t + 1; i < all.length && !all[i].classList.contains("dv-head"); i++) els.push(all[i]);
  let block = "";
  for (let i = t - 1; i >= 0; i--) {
    if (!all[i].classList.contains("dv-head")) continue;
    const l = levelOf(all[i]);
    if (l === 3) { block = words(all[i]); break; }
    if (l < 3) break;
  }
  return { tag: all[t], els, title: words(all[t]), block };
}

/** Every highlight the card came with, grey. */
export function greyOut(card: Card): void {
  card.els.forEach((el) => {
    if (el === card.tag) return;
    el.querySelectorAll<HTMLElement>("[style], mark").forEach((n) => {
      if (n.hasAttribute("data-rh")) return;
      const bg = n.style.backgroundColor;
      if (n.tagName === "MARK" || n.classList.contains("dv-hl") || (bg && bg !== "transparent")) n.style.backgroundColor = GREY;
    });
  });
}

/** What the card's paragraphs hold now — for undo. */
export const snapshot = (card: Card) => card.els.map((el) => el.innerHTML);
export const restore = (card: Card, snap: string[]) => card.els.forEach((el, i) => { el.innerHTML = snap[i] ?? el.innerHTML; });

/**
 * Highlight what is selected in green — or, if all of it is green already,
 * take the green off. Only the card's own text is touched, never its tag.
 * Says whether anything changed.
 */
export function paint(card: Card, range: Range): boolean {
  const parts: { node: Text; from: number; to: number }[] = [];
  card.els.forEach((el) => {
    if (el === card.tag) return;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) {
      if (!range.intersectsNode(n) || !n.nodeValue) continue;
      const from = n === range.startContainer ? range.startOffset : 0;
      const to = n === range.endContainer ? range.endOffset : n.nodeValue.length;
      if (to > from && n.nodeValue.slice(from, to).trim()) parts.push({ node: n, from, to });
    }
  });
  if (!parts.length) return false;
  const green = (n: Node) => (n.parentElement?.hasAttribute("data-rh") ? n.parentElement : null);
  const erase = parts.every((p) => green(p.node));

  // from the last piece back, so earlier offsets stay good
  for (let i = parts.length - 1; i >= 0; i--) {
    const { node, from, to } = parts[i];
    const span = green(node);
    const text = node.nodeValue || "";
    if (erase && span) {
      // one green span in up to three: green, plain (the grey beneath shows again), green
      const bits: Node[] = [];
      if (from > 0) bits.push(greenSpan(text.slice(0, from)));
      bits.push(document.createTextNode(text.slice(from, to)));
      if (to < text.length) bits.push(greenSpan(text.slice(to)));
      span.replaceWith(...bits);
    } else if (!erase && !span) {
      const mid = from > 0 ? node.splitText(from) : node;
      if (to - from < (mid.nodeValue || "").length) mid.splitText(to - from);
      mid.replaceWith(greenSpan(mid.nodeValue || ""));
    }
  }
  card.els.forEach((el) => el.normalize());
  return true;
}

function greenSpan(text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.setAttribute("data-rh", "");
  s.className = "dv-hl dv-rhl";
  s.style.backgroundColor = GREEN;
  s.textContent = text;
  return s;
}

/** Take all the green off, leaving the grey. */
export function clearGreen(card: Card): void {
  card.els.forEach((el) => {
    el.querySelectorAll("span[data-rh]").forEach((s) => s.replaceWith(document.createTextNode(s.textContent || "")));
    el.normalize();
  });
}

/** How many words are green. */
export const greenWords = (card: Card) =>
  card.els.reduce((n, el) => n + Array.from(el.querySelectorAll("span[data-rh]")).reduce((k, s) => k + ((s.textContent || "").match(/\S+/g) || []).length, 0), 0);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/**
 * The card as plain HTML Evidence can read: every run with its look written
 * out on it — bold, underline, size, and the highlight (grey or green) —
 * because the .docx renderer keeps much of that in stylesheets that do not
 * travel. The block it sits under heads it, so cards from one block of the
 * document land in one block of the send list.
 */
export function cardHtml(card: Card, blockTitle: string): string {
  const out: string[] = [`<h3>${esc(blockTitle)}</h3>`];
  card.els.forEach((el) => {
    const tagName = el === card.tag ? "h4" : "p";
    const runs: string[] = [];
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const t = n.nodeValue || "";
      if (!t) continue;
      const p = n.parentElement || el;
      const cs = getComputedStyle(p);
      let under = false, strike = false, bg = "";
      for (let a: HTMLElement | null = p; a && a !== el.parentElement; a = a.parentElement) {
        const line = getComputedStyle(a).textDecorationLine || "";
        if (line.includes("underline")) under = true;
        if (line.includes("line-through")) strike = true;
        if (!bg && a !== el && a.style.backgroundColor && a.style.backgroundColor !== "transparent") bg = a.style.backgroundColor;
      }
      const st = [
        parseInt(cs.fontWeight, 10) >= 600 ? "font-weight:700" : "font-weight:400",
        cs.fontStyle === "italic" ? "font-style:italic" : "",
        under || strike ? `text-decoration:${[under && "underline", strike && "line-through"].filter(Boolean).join(" ")}` : "",
        `font-size:${Math.round(parseFloat(cs.fontSize) * 0.75)}pt`,
        bg ? `background-color:${bg}` : "",
      ].filter(Boolean).join(";");
      runs.push(`<span style="${st}">${esc(t)}</span>`);
    }
    if (runs.length) out.push(`<${tagName}>${runs.join("")}</${tagName}>`);
  });
  return out.join("");
}
