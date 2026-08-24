import { expect, test, type Page } from "@playwright/test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const OVERLAP = readFixture("overlap.geojson");

/**
 * Reordering must change what is drawn, not just what the panel lists.
 *
 * `layer-panel.spec.ts` already covers the reorder interaction, but it asserts
 * only that the panel rows swap. A map that ignores the new order passes that
 * test while the user sees nothing change — which is exactly the reported bug.
 * This drops the same polygon twice (each layer gets its own palette colour, so
 * whichever is on top decides the pixels) and compares the rendered canvas
 * across a reorder.
 */

/** Ordered `data-layer-name` values of the layer rows currently in the panel. */
async function layerOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="layer-row"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-layer-name") ?? ""));
}

/** A PNG of the map canvas as currently composited. */
async function canvasShot(page: Page): Promise<Buffer> {
  return page.locator(".maplibregl-canvas").screenshot();
}

test("reordering two overlapping layers changes what the map draws", async ({ page }) => {
  await waitForMap(page);

  await dropGeoJson(page, "aaa", OVERLAP);
  await expect(layerRow(page, "aaa")).toBeVisible();
  await dropGeoJson(page, "bbb", OVERLAP);
  await expect(layerRow(page, "bbb")).toBeVisible();

  // Let the second layer's fit-to-data settle before the first capture, or the
  // comparison below would be measuring a camera move rather than the stack.
  await page.waitForTimeout(2000);
  const before = await canvasShot(page);

  const initial = (await layerOrder(page)).filter((n) => ["aaa", "bbb"].includes(n));
  expect(initial).toHaveLength(2);
  const [top, bottom] = initial;

  await layerRow(page, bottom).locator('button[aria-label="Move up"]').click();

  // The panel must reorder — if this fails the bug is in the panel or store,
  // not in rendering, and the pixel check below would be misleading.
  await expect
    .poll(async () => (await layerOrder(page)).filter((n) => ["aaa", "bbb"].includes(n)))
    .toEqual([bottom, top]);

  await page.waitForTimeout(2000);
  const after = await canvasShot(page);

  expect(
    before.equals(after),
    "the layer panel reordered but the rendered map is pixel-identical",
  ).toBe(false);
});
