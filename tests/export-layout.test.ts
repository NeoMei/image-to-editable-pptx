import assert from "node:assert/strict";
import test from "node:test";

import {
  layoutForCanvas,
  positionForBBox,
} from "../src/export/layout.js";

const LONG_SIDE_INCHES = 13.333;

const cases = [
  {
    name: "16:9 landscape",
    canvas: { width: 1600, height: 900 },
    expected: { widthInches: 13.333, heightInches: 7.4998125 },
  },
  {
    name: "4:3 landscape",
    canvas: { width: 1024, height: 768 },
    expected: { widthInches: 13.333, heightInches: 9.99975 },
  },
  {
    name: "portrait",
    canvas: { width: 900, height: 1600 },
    expected: { widthInches: 7.4998125, heightInches: 13.333 },
  },
  {
    name: "square",
    canvas: { width: 1000, height: 1000 },
    expected: { widthInches: 13.333, heightInches: 13.333 },
  },
  {
    name: "56:1 safety boundary",
    canvas: { width: 3584, height: 64 },
    expected: { widthInches: 56, heightInches: 1 },
  },
] as const;

for (const fixture of cases) {
  test(`preserves the ${fixture.name} canvas ratio within PPT limits`, () => {
    const layout = layoutForCanvas(fixture.canvas);

    assert.ok(
      Math.abs(layout.widthInches - fixture.expected.widthInches) < 1e-9,
    );
    assert.ok(
      Math.abs(layout.heightInches - fixture.expected.heightInches) < 1e-9,
    );
    assert.ok(layout.widthInches >= 1 && layout.widthInches <= 56);
    assert.ok(layout.heightInches >= 1 && layout.heightInches <= 56);
    assert.ok(
      Math.abs(
        layout.widthInches / layout.heightInches -
          fixture.canvas.width / fixture.canvas.height,
      ) < 1e-9,
    );

    const aspectRatio =
      Math.max(fixture.canvas.width, fixture.canvas.height) /
      Math.min(fixture.canvas.width, fixture.canvas.height);
    const longSide = Math.max(layout.widthInches, layout.heightInches);
    const shortSide = Math.min(layout.widthInches, layout.heightInches);
    if (LONG_SIDE_INCHES / aspectRatio >= 1) {
      assert.equal(longSide, LONG_SIDE_INCHES);
    } else {
      assert.equal(shortSide, 1);
    }
  });
}

test("maps every bbox edge through the same canvas-to-slide transform", () => {
  const canvas = { width: 900, height: 1600 };
  const layout = layoutForCanvas(canvas);
  const mapped = positionForBBox(
    { x: 90, y: 160, width: 450, height: 800 },
    canvas,
    layout,
  );

  const expected = {
    x: 0.74998125,
    y: 1.3333,
    w: 3.74990625,
    h: 6.6665,
  };
  for (const key of ["x", "y", "w", "h"] as const) {
    assert.ok(Math.abs(mapped[key] - expected[key]) < 1e-12);
  }
  assert.ok(mapped.x + mapped.w <= layout.widthInches);
  assert.ok(mapped.y + mapped.h <= layout.heightInches);
});
