/** Coordinate input parsing — pure, unit-tested, display-only.
 *  Accepted (DEC7: coordinates only, no geocoding):
 *    "34.05, -118.25" · "34.05 -118.25" · "34.05N 118.25W" · "N 34.05, W 118.25" · "34.05° N" · NBSP
 *  Rejected with a reason (never silently swapped or coerced):
 *    latitude out of range (118 → rejected, never swapped), longitude out of range, NaN, empty,
 *    exponent form, comma-decimal ("34,05"), anything that is not exactly two numbers. */

export interface ParsedCoords {
  lat: number;
  lon: number;
}

type ParseResult = { ok: true; value: ParsedCoords } | { ok: false; error: string };

export function parseCoordinates(input: string): ParseResult {
  const cleaned = input.replace(/\u00a0/g, " ").trim();
  if (!cleaned) return { ok: false, error: "enter coordinates, e.g. 34.05, -118.25" };
  if (/\d\s*[eE]\s*[+-]?\d/.test(cleaned)) {
    return { ok: false, error: "exponent form is not accepted — use plain degrees" };
  }
  // a comma-DECIMAL ("34,05") is rejected: a comma immediately between two numbers where NEITHER
  // side already has a period. "34.05, -118.25" and "-33.87,151.21" are separators and pass.
  const commaDecimal = /(^|\s)(\d{1,3}),(\d{1,3})(?=\s|$)/.exec(cleaned);
  if (commaDecimal && !commaDecimal[0].includes(".")) {
    return {
      ok: false,
      error: "comma-decimal is not accepted — use a period for decimals and a comma between the pair",
    };
  }
  // Classify each hemisphere letter from its own LOCAL position, not a single style decided once
  // from the first letter (the previous approach, which let a later prefix letter overwrite an
  // earlier number's sign on mixed-style input like "34.05N W118.25", and dropped a trailing
  // suffix letter — "N 34.05 118.25 W" — once a leading prefix letter had already fixed the
  // style). A comma/semicolon/slash is a hard separator: it always rules out reading a letter as
  // a suffix of the number before it, so "34.05, W 118.25" correctly reads W as signing 118.25
  // rather than re-signing 34.05. Within a segment (no hard separator), a letter glued to the
  // number right before it (only a degree sign or whitespace between) signs THAT number
  // ("34.05N", "34.05° N"); anywhere else it signs the number that follows it ("N 34.05").
  const segments = cleaned.replace(/°/g, " ").split(/[,;/]+/).map((s) => s.trim()).filter(Boolean);
  const numbers: number[] = [];
  // the hemisphere letter attached to each number, by position (null = none attached)
  const letterFor: (string | null)[] = [];
  let pendingLetter: string | null = null;
  for (const segment of segments) {
    const spacedSeg = segment
      .replace(/([0-9])\s*([NSEWnsew])/g, "$1 $2")
      .replace(/([NSEWnsew])\s*([0-9-])/g, "$1 $2");
    const subTokens = spacedSeg.split(/\s+/).filter(Boolean);
    let lastWasNumber = false; // reset per segment: a hard separator breaks any suffix reading
    for (const tok of subTokens) {
      if (/^[NSEW]$/i.test(tok)) {
        const L = tok.toUpperCase();
        if (lastWasNumber) {
          // suffix: the letter signs the number it immediately follows, e.g. "34.05 N"
          if (letterFor[letterFor.length - 1] != null) {
            return { ok: false, error: "two hemisphere letters for the same number" };
          }
          letterFor[letterFor.length - 1] = L;
        } else {
          // prefix: the letter signs the number that follows it, e.g. "N 34.05"
          if (pendingLetter != null) {
            return { ok: false, error: `"${pendingLetter}" has no number attached` };
          }
          pendingLetter = L;
        }
        lastWasNumber = false;
        continue;
      }
      const n = Number(tok);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `"${tok}" does not read as a number` };
      }
      numbers.push(n);
      letterFor.push(pendingLetter);
      pendingLetter = null;
      lastWasNumber = true;
    }
  }
  if (pendingLetter != null) {
    return { ok: false, error: `"${pendingLetter}" has no number attached` };
  }
  const letters = letterFor.filter((l): l is string => l != null);
  if (letters.length > 0 && letters.length !== 2) {
    return { ok: false, error: "give both hemispheres (N/S and E/W) or none" };
  }
  if (numbers.length !== 2) {
    return {
      ok: false,
      error: "expected exactly two numbers: latitude then longitude (e.g. 34.05, -118.25)",
    };
  }
  if (letters.length === 2) {
    // latitude (the first number) needs N/S; longitude (the second) needs E/W. Checking the
    // letter against the axis it actually signs — not just trusting whichever two letters showed
    // up — is what catches input like "W 34.05, S 118.25" or "N 34.05 N 118.25".
    const [latLetter, lonLetter] = letterFor as [string, string];
    if (!/^[NS]$/.test(latLetter) || !/^[EW]$/.test(lonLetter)) {
      return {
        ok: false,
        error: "latitude needs N/S and longitude needs E/W, matching the order you gave the numbers in",
      };
    }
  }
  const signOf = (L: string | null) => (L === "S" || L === "W" ? -1 : L ? 1 : 0);
  const latSign = signOf(letterFor[0]);
  const lonSign = signOf(letterFor[1]);
  const lat = latSign !== 0 ? Math.abs(numbers[0]) * latSign : numbers[0];
  const lon = lonSign !== 0 ? Math.abs(numbers[1]) * lonSign : numbers[1];
  return check(lat, lon);
}

function check(lat: number, lon: number): ParseResult {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: "those do not read as two numbers" };
  }
  if (Math.abs(lat) > 90) {
    return { ok: false, error: `latitude ${lat} outside [-90, 90] — latitude comes first` };
  }
  if (Math.abs(lon) > 180) {
    return { ok: false, error: `longitude ${lon} outside [-180, 180]` };
  }
  return { ok: true, value: { lat, lon } };
}
