// Extract complete JSON objects/arrays from tool prose without treating braces in strings as delimiters.
export function jsonFragments(text, limit = Infinity) {
  const fragments = [];
  let start = -1, stack = [], quoted = false, escaped = false;
  for (let index = 0; index < text.length && fragments.length < limit; index++) {
    const ch = text[index];
    if (start < 0) {
      if (ch === '{' || ch === '[') { start = index; stack = [ch]; quoted = false; escaped = false; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== (ch === '}' ? '{' : '[')) { start = -1; stack = []; continue; }
      if (!stack.length) {
        try { fragments.push({ start, end: index + 1, value: JSON.parse(text.slice(start, index + 1)) }); } catch {}
        start = -1;
      }
    }
  }
  return fragments;
}
