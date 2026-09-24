/**
 * A block as it sits in the send list.
 *
 * Evidence builds one of these every time a card is sent, and Flow builds one
 * when a card is sent from inside the flow — so there is exactly one place
 * that decides what a sent block looks like, and a card sent from either tool
 * lands in the send document the same way.
 *
 * `argIndex` picks one argument out of the block; leave it null for the whole
 * block. A block with no arguments sends whatever sits under its heading.
 */

const uid = (p) => (p || 'id') + '_' + Math.random().toString(36).slice(2, 10);

export function makeSendItem(block, argIndex, includeHead) {
  const single = argIndex !== null && argIndex !== undefined && argIndex >= 0;
  const args = single ? [block.args[argIndex]].filter(Boolean) : (block.args || []);

  const parts = args.map((a) => ({
    id: uid('prt'),
    title: a.title || '(untitled)',
    elems: (a.head ? [a.head] : []).concat(a.body || []),
  }));
  if (!parts.length && (block.pre || []).length) {
    parts.push({ id: uid('prt'), title: block.title, elems: block.pre.slice() });
  }
  if (!parts.length) return null;

  return {
    id: uid('snt'),
    blockId: block.id,
    title: block.title,
    trigger: block.trigger,
    head3: block.head || null,
    pre: single ? [] : (block.pre || []),
    includeHead: !!includeHead,
    open: false,
    parts,
  };
}
