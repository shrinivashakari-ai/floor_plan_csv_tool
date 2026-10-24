import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveFloorPlanPageDims, scorePageDimsFit } from "./pageDims.js";

describe("resolveFloorPlanPageDims", () => {
  it("uses MediaBox max (view[2]/view[3]) for an unrotated page", () => {
    const page = { view: [0, 0, 2002.45, 2106.29], rotate: 0 };
    const dims = resolveFloorPlanPageDims(page, [
      { rings: [[{ x: 1800, y: 1900 }, { x: 100, y: 120 }]] },
    ]);
    assert.equal(dims.source, "media");
    assert.equal(dims.width, 2002.45);
    assert.equal(dims.height, 2106.29);
  });

  it("picks rotated viewport when coords fit the swapped page", () => {
    const page = { view: [0, 0, 800, 2000], rotate: 90 };
    const areas = [{ rings: [[{ x: 1900, y: 100 }, { x: 100, y: 700 }]] }];
    const dims = resolveFloorPlanPageDims(page, areas);
    assert.equal(dims.source, "rotated");
    assert.equal(dims.width, 2000);
    assert.equal(dims.height, 800);
  });

  it("scores a containing page higher than an overflowing one", () => {
    const extent = { maxX: 900, maxY: 400 };
    assert.ok(scorePageDimsFit(extent, 1000, 500) > scorePageDimsFit(extent, 500, 1000));
  });
});
