// Coarse alert squares. Must match public.push_cell() in database/icepik_schema.sql.
// Integer maths in thousandths of a degree, so the phone and Postgres agree on
// points that sit exactly on a square's edge (sightings are rounded to 0.001°).
// Alert distances, in miles. Every push is shown, and 0.25 or 0.5 miles would
// send the same alerts as 1 mile anywhere south of 55°N, so they aren't offered.
export const ALERT_DISTANCES_MI = [1, 2, 5] as const;
export const DEFAULT_ALERT_DISTANCE_MI: (typeof ALERT_DISTANCES_MI)[number] = 1;
export const MAX_ALERT_PLACES = 5;
export const MAX_ALERT_CELLS = 1000;
const LAT_STEP = 20; // 0.020°
const LNG_STEP = 26; // 0.026°
const ROW = 20_000; // cell = row * ROW + col
const M_PER_DEG = 111_320;

export function cellOf(lat: number, lng: number): number {
  const row = Math.floor((Math.round(lat * 1000) + 90_000) / LAT_STEP);
  const col = Math.floor((Math.round(lng * 1000) + 180_000) / LNG_STEP);
  return row * ROW + col;
}

// Every square within radiusM of the square that holds the point. The result
// depends only on that square, never on where the point sits inside it.
export function cellsAround(lat: number, lng: number, radiusM: number): number[] {
  const home = cellOf(lat, lng);
  const row = Math.floor(home / ROW);
  const col = home % ROW;
  const reach = radiusM + 50;
  const south = (row * LAT_STEP - 90_000) / 1000;
  const farLat = Math.min(89, Math.max(Math.abs(south), Math.abs(south + LAT_STEP / 1000)) + reach / M_PER_DEG);
  const h = (LAT_STEP / 1000) * M_PER_DEG;
  const w = (LNG_STEP / 1000) * M_PER_DEG * Math.cos((farLat * Math.PI) / 180); // narrowest width in reach
  const dr = Math.ceil(reach / h);
  const dc = Math.ceil(reach / w);
  const cells: number[] = [];
  for (let i = -dr; i <= dr; i++) {
    for (let j = -dc; j <= dc; j++) {
      const gap = Math.hypot(Math.max(0, Math.abs(i) - 1) * h, Math.max(0, Math.abs(j) - 1) * w);
      const r = row + i;
      const c = col + j;
      if (gap <= reach && r >= 0 && r <= 9_000 && c >= 0 && c < ROW) cells.push(r * ROW + c);
    }
  }
  return cells;
}
