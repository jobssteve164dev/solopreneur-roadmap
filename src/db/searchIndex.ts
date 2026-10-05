function characters(text: string): string[] {
  return Array.from(text.toLowerCase(), character => character.codePointAt(0)!.toString(16));
}

/** Contentless postings support exact substring candidates, including one-character queries. */
export function indexTokens(text: string): string {
  const chars = characters(text);
  const tokens = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    tokens.add('g' + chars[i]);
    if (i + 1 < chars.length) tokens.add('g' + chars[i] + 'x' + chars[i + 1]);
    if (i + 2 < chars.length) tokens.add('g' + chars[i] + 'x' + chars[i + 1] + 'x' + chars[i + 2]);
  }
  return [...tokens].join(' ');
}

export function queryTokens(query: string): string {
  const chars = characters(query);
  const tokens = new Set<string>();
  const width = Math.min(3, chars.length);
  for (let i = 0; i <= chars.length - width; i++) tokens.add('g' + chars.slice(i, i + width).join('x'));
  return [...tokens].map(token => '"' + token + '"').join(' AND ');
}
