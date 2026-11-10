/**
 * The caselist's worker: core.js, answering the page's questions by message.
 * { id, op, args } in; { id, result } or { id, error } back; { ev, … } when
 * something is happening that nobody asked about (an index downloading).
 */

import { createCore } from './core';

const core = createCore((m) => self.postMessage(m));

self.onmessage = async (e) => {
  const { id, op, args } = e.data || {};
  try {
    const result = await core[op](args);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
