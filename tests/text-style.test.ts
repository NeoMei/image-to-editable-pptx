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

test("budgets two CJK lines by the widest line and per-line height", () => {
  const style = inferEditableTextStyle(
    "工具\n生态",
    { x: 0, y: 0, width: 40, height: 80 },
    metrics({ glyphBounds: { x: 0, y: 0, width: 38, height: 60 } }),
  );

  assert.equal(style.fontSizePx, 19.2);
});

test("gives A newline B two line boxes instead of one AB line box", () => {
  const geometry = metrics({
    glyphBounds: { x: 0, y: 0, width: 60, height: 40 },
  });
  const oneLine = inferEditableTextStyle("AB", bbox, geometry);
  const twoLines = inferEditableTextStyle("A\nB", bbox, geometry);

  assert.equal(oneLine.fontSizePx, 37.6);
  assert.equal(twoLines.fontSizePx, 18.8);
});

test("normalizes CRLF and budgets Latin width by World rather than both lines", () => {
  const style = inferEditableTextStyle(
    "Hello\r\nWorld",
    { x: 0, y: 0, width: 56, height: 200 },
    metrics({ glyphBounds: { x: 0, y: 0, width: 54, height: 100 } }),
  );

  assert.equal(style.fontSizePx, 18.8);
});

test("classifies multiline bold from per-line stroke geometry", () => {
  const singleLine = inferEditableTextStyle(
    "AB",
    bbox,
    metrics({
      glyphBounds: { x: 0, y: 0, width: 60, height: 20 },
      inBoxForegroundCoverage: 0.3,
      estimatedStrokeWidthPx: 3,
    }),
  );
  const twoLines = inferEditableTextStyle(
    "A\nB",
    { ...bbox, height: 80 },
    metrics({
      glyphBounds: { x: 0, y: 0, width: 30, height: 40 },
      inBoxForegroundCoverage: 0.3,
      estimatedStrokeWidthPx: 3,
    }),
  );

  assert.equal(singleLine.bold, true);
  assert.equal(twoLines.bold, singleLine.bold);
});
