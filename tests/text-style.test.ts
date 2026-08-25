import assert from "node:assert/strict";
import test from "node:test";

import { inferEditableTextStyle } from "../src/fidelity/text-style.js";

const bbox = { x: 0, y: 0, width: 100, height: 40 };

function metrics(overrides: Partial<Parameters<typeof inferEditableTextStyle>[2]> = {}) {
  return {
    glyphBounds: { x: 4, y: 5, width: 80, height: 20 },
    inBoxForegroundCoverage: 0.12,
    estimatedStrokeWidthPx: 1,
    ...overrides,
  };
}

test("infers regular and bold styles from normalized stroke geometry", () => {
  const regular = inferEditableTextStyle("ABCD", bbox, metrics());
  const bold = inferEditableTextStyle(
    "ABCD",
    bbox,
    metrics({ inBoxForegroundCoverage: 0.3, estimatedStrokeWidthPx: 3 }),
  );

  assert.equal(regular.bold, false);
  assert.equal(bold.bold, true);
});

test("uses named CJK, Latin, and mixed advance budgets", () => {
  const narrow = { x: 0, y: 0, width: 60, height: 80 };
  const tallGlyphs = metrics({ glyphBounds: { x: 0, y: 0, width: 50, height: 50 } });
  const cjk = inferEditableTextStyle("工具", narrow, tallGlyphs).fontSizePx;
  const mixed = inferEditableTextStyle("工A", narrow, tallGlyphs).fontSizePx;
  const latin = inferEditableTextStyle("AB", narrow, tallGlyphs).fontSizePx;

  assert.ok(cjk < mixed);
  assert.ok(mixed < latin);
});

test("lets width rather than measured height limit a long CJK string", () => {
  const style = inferEditableTextStyle(
    "工具工具",
    { x: 0, y: 0, width: 80, height: 80 },
    metrics({ glyphBounds: { x: 0, y: 0, width: 70, height: 50 } }),
  );

  assert.equal(style.fontSizePx, 19.2);
});

test("clamps degenerate text inputs to a positive finite font size", () => {
  const style = inferEditableTextStyle(
    "",
    { x: 0, y: 0, width: 0.01, height: 0.01 },
    metrics({ glyphBounds: { x: 0, y: 0, width: 1, height: 1 } }),
  );

  assert.ok(Number.isFinite(style.fontSizePx));
  assert.ok(style.fontSizePx > 0);
});
