// DOM and bridge helpers shared by the browser UI modules.

export const pure = window.pure;

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Writes only when the value changed (frequent tab events must not cause needless DOM writes).
export function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}
