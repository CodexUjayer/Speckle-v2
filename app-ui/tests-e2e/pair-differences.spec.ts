import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Two dots -> every difference, on the Explorer's own map (no separate workspace).
 *  /api/granules, /api/background/granule, /explain and /diff are intercepted with fixtures (the engine is
 *  offline in CI). The granule inventory's `diff_modes` is what the real engine sends; the tile list must
 *  mirror it exactly — one tile per (layer, valid mode) — and clicking a tile must ask the engine for THAT mode. */
const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures", "granules-bbox.json"), "utf8")) as {
  granules: { id: string; stack: string; product: string | null }[];
};
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64");
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "X-Img-Meta" };
const BOX = "west=-118.45&south=33.7&east=-118.05&north=34.3";

const L_POW = "science__LSAR__GCOV__grids__frequencyA__HHHH";
const L_COH = "science__LSAR__GUNW__grids__frequencyA__unwrappedInterferogram__HH__coherenceMagnitude";
const L_PHASE = "science__LSAR__GUNW__grids__frequencyA__unwrappedInterferogram__HH__unwrappedPhase";
const L_MASK = "science__LSAR__GCOV__grids__frequencyA__mask";

const VALID: Record<string, string[]> = {
  [L_POW]: ["db_diff", "ratio"], [L_COH]: ["coh_diff"], [L_PHASE]: ["los_m", "los_mm"], [L_MASK]: [],
};
const MODES = ["db_diff", "ratio", "coh_diff", "los_m", "los_mm"];

const corners = () => [[-118.45, 34.3], [-118.05, 34.3], [-118.05, 33.7], [-118.45, 33.7]];

function detail(id: string) {
  const g = FIXTURE.granules.find((x) => x.id === id) ?? FIXTURE.granules[0];
  return {
    ok: true, id, granule: g, decoded: {}, group: null, grouped: false,
    inventory: {
      grids: [{
        path: "science/LSAR/GCOV/grids/frequencyA", key: "science__LSAR__GCOV__grids__frequencyA",
        epsg: 32611, nx: 100, ny: 100, dx: 20, dy: 20, extras: [],
        layers: Object.keys(VALID).map((k) => ({
          path: k.replace(/__/g, "/"), key: k, shape: [100, 100], dtype: "float32", chunks: null, readable: true,
          why_not: null, previewable: true, role: k === L_MASK ? "cov_mask" : "cov", kind: "power", default_cmap: "gray",
          what_it_is: "fixture layer",
          diff_modes: Object.fromEntries(MODES.map((m) => [m, {
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
    id: idB, layer, cmap: "diverging", scale: mode, unit: mode.startsWith("los") ? "mm" : "dB", lo: -6, hi: 6,
    shown_stride: 1, shown_shape: [2, 2], epsg: 32611,
    clip_bbox_lonlat: [-118.45, 33.7, -118.05, 34.3], requested_bbox: [-118.45, 33.7, -118.05, 34.3],
    corners_lonlat: corners(), corners_note: null,
    stats: { shape: [10, 10], dtype: "float32", min: -5, max: 5, mean: 0, p2: -4, p50: 0, p98: 4, nan_fraction: 0, n_bytes: 400 },
    cache_hit: false, notes: [],
    diff: {
      mode, mode_label: `${mode} (engine label)`, id_a: idA, id_b: idB,
      date_a: "2026-06-20T13:08:23Z", date_b: "2026-09-12T13:08:23Z", window_a: null, window_b: null,
      gap_days: 84, later: "b", gap_rule: "gap between the acquisition dates",
      validation: {}, same_grid: true, resampled: null, modes: {},
      ...(mode.startsWith("los") ? { referencing: {
        shared_reference_date: false, reference_date_a: null, reference_date_b: null, window_a: [], window_b: [],
        note: "the granules do NOT share a reference date (fixture note)", formula: "f", assumptions: [],
      } } : {}),
    },
  };
}

async function routeEngine(page: Page, diffCalls: URLSearchParams[]) {
  await page.route("**/api/health**", (r) => r.fulfill({ json: { ok: true, scans_enabled: false, earthdata_credentials: "present",
    cache_write: { status: "disabled", reason: null } } }));
  await page.route("**/api/granules**", (r) => r.fulfill({ json: FIXTURE }));
  await page.route("**/api/background/granule**", (r) =>
    r.fulfill({ json: detail(new URL(r.request().url()).searchParams.get("id") ?? FIXTURE.granules[0].id) }));
  await page.route("**/api/background/explain**", (r) => r.fulfill({ json: {
    ok: true, nodes: {}, steps: [], layers: {}, pipelines: {}, counts: { declared: 0, modelled: 0, modelled_names: [] },
    diff_modes: { db_diff: { what_it_is: "Change in backscatter in dB.", how_to_read: "blue less, red more.", misread: "not damage by itself." } },
  } }));
  await page.route("**/api/background/diff**", (r) => {
    const q = new URL(r.request().url()).searchParams;
    diffCalls.push(q);
    return r.fulfill({ status: 200, body: PNG, contentType: "image/png", headers: { ...CORS,
      "X-Img-Meta": JSON.stringify(diffMeta(q.get("mode") ?? "auto", q.get("layer") ?? "", q.get("id_a") ?? "", q.get("id_b") ?? "")) } });
  });
}

const row = (page: Page, re: RegExp) => page.locator("tr", { hasText: re }).first();

test.describe("pair differences on the explorer map (fixtures)", () => {
  test("shift-click two dots: one tile per (layer, valid mode); a tile asks the engine for exactly that mode", async ({ page }) => {
    const calls: URLSearchParams[] = [];
    await routeEngine(page, calls);
    await page.goto(`/background/retrieval?${BOX}&level=GUNW,GCOV`);
    await page.getByLabel("List view").check();

    await row(page, /GCOV.*20260620T130823/).click();
    await row(page, /GCOV.*20260912T130823/).click({ modifiers: ["Shift"] });

    const tiles = page.getByRole("list", { name: "all differences for this pair" }).getByRole("button");
    // HHHH: db_diff + ratio, coherence: coh_diff, phase: los_m + los_mm; the mask layer has none -> not a tile
    await expect(tiles).toHaveCount(5);
    await expect(page.getByText("1 other shared layer(s) have no difference defined")).toBeVisible();

    // every tile was asked for, one mode each (plus the large picture of the selected one)
    await expect.poll(() => new Set(calls.map((c) => c.get("mode"))).size).toBe(5);
    expect([...new Set(calls.map((c) => c.get("mode")))].sort()).toEqual([...MODES].sort());
    // earlier date is id_a, later is id_b (the engine states "later minus earlier")
    expect(calls[0].get("id_a")).toMatch(/20260620T130823/);
    expect(calls[0].get("id_b")).toMatch(/20260912T130823/);

    // clicking the los_mm tile draws THAT difference big and shows the engine's referencing note
    calls.length = 0;
    await tiles.filter({ hasText: "los_mm" }).click();
    await expect(page.getByText("the granules do NOT share a reference date (fixture note)")).toBeVisible();
    await expect.poll(() => calls.some((c) => c.get("mode") === "los_mm" && c.get("max_px") === "512")).toBe(true);
    await expect(page.getByText("gap 84 d").first()).toBeVisible();
  });

  test("arm 'compare with another date', then a plain click on the second dot", async ({ page }) => {
    const calls: URLSearchParams[] = [];
    await routeEngine(page, calls);
    await page.goto(`/background/retrieval?${BOX}&level=GUNW,GCOV`);
    await page.getByLabel("List view").check();
    await row(page, /GCOV.*20260620T130823/).click();
    await page.getByTestId("pick-second").click();
    await row(page, /GCOV.*20260831T130823/).click();
    await expect(page.getByTestId("pair-differences")).toBeVisible();
    // a plain click with nothing armed starts over with one dot (the single-dot detail again)
    await row(page, /GCOV.*20260707T130823|GCOV.*20260726T130823/).click();
    await expect(page.getByTestId("pair-differences")).toHaveCount(0);
  });

  test("two dots from different stacks: stated, and the engine is never asked for a difference", async ({ page }) => {
    const calls: URLSearchParams[] = [];
    await routeEngine(page, calls);
    await page.goto(`/background/retrieval?${BOX}&level=GUNW,GCOV`);
    await page.getByLabel("List view").check();
    await row(page, /GCOV.*20260620T130823/).click();
    await row(page, /GCOV.*20260626T01/).click({ modifiers: ["Shift"] });
    await expect(page.getByText(/different stacks/)).toBeVisible();
    await page.waitForTimeout(500);
    expect(calls.length).toBe(0);
  });
});
