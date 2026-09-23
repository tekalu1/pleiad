export function parseCommand(text) {
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (const ch of String(text ?? "")) {
    if (quote) {
      if (ch === quote) quote = null;
      else { cur += ch; has = true; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ""; has = false; }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

