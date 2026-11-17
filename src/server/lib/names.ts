/**
 * Heuristic channel-name cleanup. Deliberately conservative; agents can do the rest via the API.
 *   "US: ESPN 2 FHD"        -> "ESPN 2"
 *   "|UK| Sky Sports Main Event ᴴᴰ" -> "Sky Sports Main Event"
 *   "USA ➾ CNN (Backup)"    -> "CNN"
 */
const QUALITY = /\b(?:UHD|FHD|HD|SD|HEVC|H\.?265|4K|8K|1080[pi]?|720p|50fps|60fps|HDR|RAW)\b/gi
const SUPERSCRIPT = /[ᴴᴰˢᴰᵁᴿᴬᵂ⁴ᴷ]+/g

export function cleanChannelName(input: string): string {
  let s = input.normalize('NFKC')
  s = s.replace(SUPERSCRIPT, ' ')
  // leading country/provider tags: "US:", "US |", "|US|", "[US]", "(US)", "US -", "US ➾"
  s = s.replace(/^\s*(?:[|[(]\s*)?[A-Z]{2,4}(?:\s*[|\])])?\s*[:|\-–➾»►•]+\s*/u, '')
  s = s.replace(/^\s*[|[(][A-Z0-9 ]{2,8}[|\])]\s*/u, '')
  // trailing noise
  s = s.replace(/\((?:backup|alt|alternative|multi[- ]?audio|geo[- ]?blocked)\)/gi, ' ')
  s = s.replace(QUALITY, ' ')
  s = s.replace(/[|★☆●◉■□▶►➾»«]+/g, ' ')
  s = s.replace(/\s{2,}/g, ' ').replace(/[\s\-–:]+$/g, '').trim()
  return s || input.trim()
}

/** Normalised key for fuzzy matching (EPG suggestions, dedupe). */
export function nameKey(s: string) {
  return cleanChannelName(s.replace(/\.[a-z]{2,3}$/i, '')) // xmltv ids like "espn2.us"
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]/g, '')
}

/** Similarity 0..1 using bigram Dice coefficient on normalised keys. */
export function similarity(a: string, b: string) {
  const x = nameKey(a)
  const y = nameKey(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const grams = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ga = grams(x)
  const gb = grams(y)
  let inter = 0
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0)
  const total = Math.max(1, x.length - 1 + (y.length - 1))
  return (2 * inter) / total
}
