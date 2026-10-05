import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DE = path.join(__dirname, '..', '..', '..', 'locales', 'de');
// PRODUCT.md: the tone is slightly formal. Sell and account once spoke "du" while the room spoke "Sie".
const DU = /\b(du|Du|dich|dir|dein|deine|deinen|deinem|deiner|deines|euch|euer|eure)\b|\b(Melde|Versuche|Prüfe|Öffne|Starte|Wähle|Bleibe|Erstelle|Verbinde|Gib|Nutze|Hebe|Gehe|Lade) (dich|es|die|das|ein|einen|der|sie|Karten|Ziffern|Buchstaben|zurück|bis|eine)\b/;

function strings(o: unknown, out: string[] = []): string[] {
  if (typeof o === 'string') out.push(o);
  else if (Array.isArray(o)) o.forEach((v) => strings(v, out));
  else if (o && typeof o === 'object') Object.values(o).forEach((v) => strings(v, out));
  return out;
}

describe('German copy addresses the reader as Sie', () => {
  for (const f of fs.readdirSync(DE).filter((n) => n.endsWith('.json'))) {
    it(f, () => {
      const bad = strings(JSON.parse(fs.readFileSync(path.join(DE, f), 'utf8'))).filter((s) => DU.test(s));
      expect(bad).toEqual([]);
    });
  }
});
