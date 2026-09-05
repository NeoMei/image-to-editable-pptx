import assert from "node:assert/strict";
import test from "node:test";

import { inferEditableTextStyle } from "../src/fidelity/text-style.js";

const bbox = { x: 0, y: 0, width: 100, height: 40 };

test("tracking retains the width safety budget for a height-limited Latin title", () => {
  const style = inferEditableTextStyle(
    "MODEL ROUTING",
    { x: 73, y: 64, width: 405, height: 37 },
    {
      glyphBounds: { x: 73, y: 64, width: 402, height: 36 },
      inBoxForegroundCoverage: 0.3,
      estimatedStrokeWidthPx: 4,
    },
  );
  // The title's approximate 7.79em natural advance must not spend the
  // entire measured span after tracking: real font advances vary.
  assert.equal(style.fontSizePx, 33.84);
  assert.ok(style.fontSizePx * 7.79 + style.charSpacingPx * 12 <= 386);
});

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

test("infers zero or positive tracking from measured CJK, Latin, and mixed spans", () => {
  const geometry = (width: number) =>
    metrics({ glyphBounds: { x: 4, y: 5, width, height: 20 } });

  assert.equal(
    inferEditableTextStyle("工具", bbox, geometry(30)).charSpacingPx,
    0,
  );
  assert.ok(
    inferEditableTextStyle("工具", bbox, geometry(50)).charSpacingPx > 0,
  );
  assert.ok(
    inferEditableTextStyle("AB", bbox, geometry(50)).charSpacingPx > 0,
  );
  assert.ok(
    inferEditableTextStyle("工A", bbox, geometry(50)).charSpacingPx > 0,
  );
});

test("tracking handles whitespace and single characters conservatively", () => {
  const wide = metrics({
    glyphBounds: { x: 4, y: 5, width: 80, height: 20 },
  });
  assert.ok(inferEditableTextStyle("A B", bbox, wide).charSpacingPx > 0);
  assert.equal(inferEditableTextStyle("A", bbox, wide).charSpacingPx, 0);
  assert.equal(inferEditableTextStyle(" ", bbox, wide).charSpacingPx, 0);
});

test("bounds extreme tracking by a named generic limit", () => {
  const style = inferEditableTextStyle(
    "AB",
    { x: 0, y: 0, width: 1_000, height: 40 },
    metrics({ glyphBounds: { x: 0, y: 0, width: 900, height: 20 } }),
  );
  assert.equal(style.charSpacingPx, 36);
});

test("uses a generic display-text advance scale for widely tracked headings", () => {
  const style = inferEditableTextStyle(
    "第4章工具",
    { x: 0, y: 0, width: 529, height: 92 },
    metrics({ glyphBounds: { x: 4, y: 5, width: 521, height: 83 } }),
  );

  assert.ok(style.fontSizePx >= 48);
  assert.ok(style.charSpacingPx > 30);
  assert.ok(style.charSpacingPx <= 36);
});

test("multiline tracking chooses one deterministic bounded value", () => {
  const calculate = () =>
    inferEditableTextStyle(
      "工具生态\nAB",
      { x: 0, y: 0, width: 120, height: 80 },
      metrics({ glyphBounds: { x: 0, y: 0, width: 100, height: 60 } }),
    ).charSpacingPx;
  const tracking = calculate();

  assert.ok(tracking >= 0);
  assert.ok(tracking <= 36);
  assert.equal(tracking, calculate());
});
