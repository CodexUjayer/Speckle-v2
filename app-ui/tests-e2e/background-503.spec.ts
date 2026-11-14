import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The Background views show the engine's own text when it answers 503 (e.g. no Earthdata credentials).
 *  There is no access key any more, so no 503 or 401 is ever turned into a token prompt.
 *  Engine routes are intercepted (fixtures, not a live engine). Covered on a retrieval route (granule detail),
 *  a preprocessing route and a pipelines route. */

const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures", "granules-bbox.json"), "utf8")) as {
  granules: unknown[]; groups: unknown[];
};
const BOX = "west=-118.45&south=33.7&east=-118.05&north=34.3&level=GUNW,GCOV";
const MSG_NO_EARTHDATA =
  "no Earthdata credentials in the environment (set EARTHDATA_TOKEN, or EARTHDATA_USERNAME and EARTHDATA_PASSWORD)";

const answer = () => ({ status: 503, json: { detail: { ok: false, error: MSG_NO_EARTHDATA } } });

async function expectEngineText(page: import("@playwright/test").Page) {
  await expect(page.getByText(MSG_NO_EARTHDATA).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog", { name: /token/i })).toHaveCount(0);
}

test("retrieval route (granule detail): 503 shows the engine's text, no token dialog", async ({ page }) => {
  await page.route("**/api/health**", (r) => r.fulfill({ json: { ok: true, scans_enabled: false,
    earthdata_credentials: "present", cache_write: { status: "disabled", reason: null } } }));
  await page.route("**/api/granules**", (r) => r.fulfill({ json: FIXTURE }));
  await page.route("**/api/tile-at**", (r) => r.fulfill({
    json: { ok: true, tile: { id: "11SLT86", epsg: 32611, size_m: 10000,
      bbox_lonlat: [-118.45, 33.7, -118.05, 34.3], center_lonlat: [-118.25, 34.05],
      polygon_lonlat: [[-118.45, 33.7], [-118.05, 33.7], [-118.05, 34.3], [-118.45, 34.3], [-118.45, 33.7]] } } }));
  await page.route("**/api/background/granule**", (r) => r.fulfill(answer()));
  await page.goto(`/background/retrieval?${BOX}`);
  await page.getByLabel("List view").check();
  await page.locator("tr", { hasText: "NISAR_L2_PR_GCOV_027_034" }).first().click();
  await page.getByRole("tab", { name: "Layers" }).click();
  await expectEngineText(page);
});

async function routeRunsEngine(page: import("@playwright/test").Page) {
  await page.route("**/api/health**", (r) => r.fulfill({ json: { ok: true } }));
  await page.route("**/api/runs**", (r) => r.fulfill({
    json: { ok: true, runs: [{ id: "run-e2e-1", status: "ok", kind: "scan", tile: "11SLT66" }] } }));
  await page.route("**/api/bundles**", (r) => r.fulfill({ json: { ok: true, bundles: [] } }));
  await page.route("**/api/pipelines**", (r) => r.fulfill({
    json: { ok: true, implemented_count: 1, pipelines: [
      { name: "earthquake_coseismic", code: "3.01", sensor: "sar", applies: "coseismic earthquakes",
        uses_codes: ["M1"], fetch_codes: ["R1"], min_epochs: 2, status_values: ["SUPPORTED"],
        implemented: true, execution: "normal", needs_sar: true },
    ] } }));
  await page.route("**/api/background/runs/*/preprocessing**", (r) => r.fulfill(answer()));
  await page.route("**/api/background/runs/*/pipelines/*", (r) => r.fulfill(answer()));
}

test("preprocessing route: 503 shows the engine's text, no token dialog", async ({ page }) => {
  await routeRunsEngine(page);
  await page.goto("/background/preprocessing");
  await page.getByLabel("pick a run").selectOption("run-e2e-1");
  await expectEngineText(page);
});

test("pipelines route: 503 shows the engine's text, no token dialog", async ({ page }) => {
  await routeRunsEngine(page);
  await page.goto("/background/pipelines/earthquake_coseismic?run=run-e2e-1");
  await expectEngineText(page);
});
