import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Map page: click two dots on the bottom timeline -> every difference for the pair, drawn on the map.
 *  The engine is offline in CI, so /api/health, /api/tile-at, /api/granules (per-tile search), the granule
 *  inventory, /explain and /diff are FIXTURES. The inventory's `diff_modes` is what the real engine sends: the tile
 *  list must mirror it exactly (one tile per layer and valid mode) and a tile must ask the engine for THAT mode. */
const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures", "granules-bbox.json"), "utf8")) as {
  window: { t0: string; t1: string };
  granules: { id: string; stack: string; product: string | null; direction: string; track: number; frame: number | null;
              start: string | null; footprint: [number, number][] | null }[];
};
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64");
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-Img-Meta" };
const TILE = {
  ok: true,
  tile: {
    id: "46QGJ79", epsg: 32646, size_m: 10000,
    bbox_lonlat: [90.37, 23.7, 90.47, 23.79], center_lonlat: [90.41847, 23.74797],
    polygon_lonlat: [[90.37, 23.7], [90.47, 23.7], [90.47, 23.79], [90.37, 23.79], [90.37, 23.7]],
  },
};

const L_HH = "science__LSAR__GCOV__grids__frequencyA__HHHH";
const L_HV = "science__LSAR__GCOV__grids__frequencyA__HVHV";
const L_MASK = "science__LSAR__GCOV__grids__frequencyA__mask";
const POWER_MODES = ["db_diff", "ratio", "z_db"];
const VALID: Record<string, string[]> = { [L_HH]: POWER_MODES, [L_HV]: POWER_MODES, [L_MASK]: [] };
const ALL_MODES = ["db_diff", "ratio", "z_db", "coh_diff", "los_m", "los_mm"];
const corners = () => [[90.37, 23.79], [90.47, 23.79], [90.47, 23.7], [90.37, 23.7]];

/** the per-tile search answer the Map's Data panel reads: stacks of GCOV epochs, one marker per acquisition */
function tileSearch() {
  const stacks: Record<string, unknown> = {};
  for (const g of FIXTURE.granules.filter((x) => x.product === "GCOV")) {
    const st = (stacks[g.stack] ??= { direction: g.direction, track: g.track, gunw: [], gcov: [] }) as { gcov: unknown[] };
    st.gcov.push({ time: g.start, granule_ids: [g.id], frame: g.frame, footprint: g.footprint });
  }
  return {
    ok: true, tile: TILE.tile, window: FIXTURE.window, stacks, search_errors: {}, search_degraded: false,
    dropped_older: 0, flags: [],
  };
}

function detail(id: string) {
  const g = FIXTURE.granules.find((x) => x.id === id) ?? FIXTURE.granules[0];
  return {
    ok: true, id, granule: g, decoded: {}, group: null, grouped: false,
    inventory: {
      grids: [{
        path: "science/LSAR/GCOV/grids/frequencyA", key: "science__LSAR__GCOV__grids__frequencyA",
        epsg: 32646, nx: 100, ny: 100, dx: 20, dy: 20, extras: [],
        layers: Object.keys(VALID).map((k) => ({
          path: k.replace(/__/g, "/"), key: k, shape: [100, 100], dtype: "float32", chunks: null, readable: true,
          why_not: null, previewable: true, role: k === L_MASK ? "cov_mask" : "cov", kind: "power", default_cmap: "gray",
          what_it_is: "fixture layer",
          diff_modes: Object.fromEntries(ALL_MODES.map((m) => [m, {
            valid: VALID[k].includes(m), reason: VALID[k].includes(m) ? null : `${m} is not defined for this layer`,
          }])),
        })),
      }],
      source: "fixture", n_layers: Object.keys(VALID).length,
    },
    inventory_note: null, footprint: null,
  };
}

function diffMeta(mode: string, layer: string, idA: string, idB: string) {
  return {
    id: idB, layer, cmap: "diverging", scale: mode, unit: mode === "z_db" ? "σ" : "dB", lo: -6, hi: 6,
    shown_stride: 1, shown_shape: [2, 2], epsg: 32646,
    clip_bbox_lonlat: [90.37, 23.7, 90.47, 23.79], requested_bbox: [90.37, 23.7, 90.47, 23.79],
    corners_lonlat: corners(), corners_note: null,
    stats: { shape: [10, 10], dtype: "float32", min: -5, max: 5, mean: 0, p2: -4, p50: 0, p98: 4, nan_fraction: 0, n_bytes: 400 },
    cache_hit: false, notes: [],
    diff: {
      mode, mode_label: `${mode} (engine label)`, id_a: idA, id_b: idB,
      date_a: "2026-06-20T13:08:23Z", date_b: "2026-09-12T13:08:23Z", window_a: null, window_b: null,
      gap_days: 84, later: "b", gap_rule: "gap between the acquisition dates",
      validation: {}, same_grid: true, resampled: null, modes: {},
    },
  };
}

async function routeEngine(page: Page, diffCalls: URLSearchParams[]) {
  await page.route("**/api/health**", (r) => r.fulfill({ json: { ok: true, scans_enabled: false, earthdata_credentials: "present",
    granule_search: { status: "enabled", reason: null }, cache_write: { status: "disabled", reason: null } } }));
  await page.route("**/api/tile-at**", (r) => r.fulfill({ json: TILE }));
  await page.route("**/api/pipelines**", (r) => r.fulfill({ json: { ok: true, pipelines: [], implemented_count: 0 } }));
  await page.route("**/api/granules**", (r) => r.fulfill({ json: tileSearch() }));
  await page.route("**/api/background/granule**", (r) =>
    r.fulfill({ json: detail(new URL(r.request().url()).searchParams.get("id") ?? FIXTURE.granules[0].id) }));
  await page.route("**/api/background/explain**", (r) => r.fulfill({ json: {
    ok: true, nodes: {}, steps: [], layers: {}, pipelines: {}, counts: { declared: 0, modelled: 0, modelled_names: [] },
    diff_modes: { z_db: { what_it_is: "Change in speckle-noise units (fixture).", how_to_read: "blue drop, red rise.", misread: "two dates only." } },
  } }));
  await page.route("**/api/background/diff**", (r) => {
    const q = new URL(r.request().url()).searchParams;
    diffCalls.push(q);
    return r.fulfill({ status: 200, body: PNG, contentType: "image/png", headers: { ...CORS,
      "X-Img-Meta": JSON.stringify(diffMeta(q.get("mode") ?? "auto", q.get("layer") ?? "", q.get("id_a") ?? "", q.get("id_b") ?? "")) } });
  });
}

const dot = (page: Page, day: string) => page.getByRole("button", { name: `acquisition ${day}` }).first();

test.describe("two dots on the Map's timeline -> every difference (fixtures)", () => {
  test("first dot = A, second dot in the same row = B: one tile per (layer, valid mode); a tile asks for that mode", async ({ page }) => {
    const calls: URLSearchParams[] = [];
    await routeEngine(page, calls);
    await page.goto("/map?lat=23.74797&lon=90.41847");
    await expect(page.locator("svg[aria-label*='Granule timeline']")).toBeVisible({ timeout: 20_000 });

    await dot(page, "2026-06-20").click();
    await expect(page.getByTestId("map-pair-differences")).toHaveCount(0);      // one dot is still the single-granule view
    await dot(page, "2026-09-12").click();

    await expect(page.getByTestId("map-pair-differences")).toBeVisible();
    // HHHH and HVHV: db_diff + ratio + z_db each; the mask layer has none -> not a tile
    const tiles = page.getByRole("list", { name: "all differences for this pair" }).getByRole("button");
    await expect(tiles).toHaveCount(6);
    await expect(page.getByText("1 other shared layer(s) have no difference defined")).toBeVisible();

    await expect.poll(() => new Set(calls.map((c) => c.get("mode"))).size).toBe(3);
    expect([...new Set(calls.map((c) => c.get("mode")))].sort()).toEqual([...POWER_MODES].sort());
    // earlier date is id_a, later is id_b (the engine states "later minus earlier")
    expect(calls[0].get("id_a")).toMatch(/20260620T130823/);
    expect(calls[0].get("id_b")).toMatch(/20260912T130823/);

    // a picked tile is the one drawn: its engine text and teaching copy appear
    await page.getByTestId("pair-tile-z_db").first().click();
    await expect(page.getByText("Change in speckle-noise units (fixture).")).toBeVisible();
    await expect(page.getByText("gap 84 d").first()).toBeVisible();
  });

  test("a third click, or a dot in another row, starts over; × clears the pair", async ({ page }) => {
    const calls: URLSearchParams[] = [];
    await routeEngine(page, calls);
    await page.goto("/map?lat=23.74797&lon=90.41847");
    await expect(page.locator("svg[aria-label*='Granule timeline']")).toBeVisible({ timeout: 20_000 });

    await dot(page, "2026-06-20").click();
    await dot(page, "2026-09-12").click();
    await expect(page.getByTestId("map-pair-differences")).toBeVisible();

    await dot(page, "2026-07-02").click();                                       // 3rd click: new A, no pair
    await expect(page.getByTestId("map-pair-differences")).toHaveCount(0);

    calls.length = 0;
    await dot(page, "2026-06-26").click();                                       // other row (D071): new A, never a pair
    await page.waitForTimeout(500);
    await expect(page.getByTestId("map-pair-differences")).toHaveCount(0);
    expect(calls.length).toBe(0);

    await dot(page, "2026-06-20").click();
    await dot(page, "2026-09-12").click();
    await expect(page.getByTestId("map-pair-differences")).toBeVisible();
    await page.getByRole("button", { name: "clear the two picked dots" }).click();
    await expect(page.getByTestId("map-pair-differences")).toHaveCount(0);
  });
});
