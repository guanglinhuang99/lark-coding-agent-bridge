/** Lossless UTF-8 pagination shared by all presentations. No channel SDK dependency. */
export function splitRiskMessage(text: string, maxBytes = 12_000): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error('Invalid message budget');
  const pages: string[] = [];
  let part = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) { pages.push(part); part = ''; bytes = 0; }
    part += character;
    bytes += size;
  }
  if (part) pages.push(part);
  return pages;
}
