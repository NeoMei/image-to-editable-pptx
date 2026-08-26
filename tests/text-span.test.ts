import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import type { SlideManifest } from "../src/contracts.js";
import {
  measureTextSpanAcceptance,
  TEXT_ANCHOR_TOLERANCE_PX,
  TEXT_SPAN_TOLERANCE_PX,
} from "../src/acceptance/text-span.js";

const canvas = { width: 1280 as const, height: 720 as const };

function fixtureManifest(): SlideManifest {
  return {
    manifestVersion: 1,
    canvas,
    elements: Array.from({ length: 10 }, (_, index) => ({
      kind: "text" as const,
      id: `text-${index + 1}`,
      text: `line ${index + 1}`,
      bbox: { x: 20, y: 20 + index * 60, width: 200, height: 30 },
      rotation: 0,
      color: "23394D",
      fontSizePx: 24,
      align: "left" as const,
      zIndex: index,
    })),
    warnings: [],
  };
}

async function foregroundFixture(
  leftOffset: number,
  width: number,
): Promise<Buffer> {
  const background = Buffer.alloc(canvas.width * canvas.height * 3, 255);
  for (let line = 0; line < 10; line += 1) {
    for (let y = 25 + line * 60; y < 45 + line * 60; y += 1) {
      for (let x = 25 + leftOffset; x < 25 + leftOffset + width; x += 1) {
        const pixel = (y * canvas.width + x) * 3;
        background[pixel] = 0x23;
        background[pixel + 1] = 0x39;
        background[pixel + 2] = 0x4d;
      }
    }
  }
  return sharp(background, { raw: { ...canvas, channels: 3 } }).png().toBuffer();
}

test("measures source-backed span and anchor tolerance for every manifest text", async () => {
  const evidence = await measureTextSpanAcceptance(
    await foregroundFixture(0, 100),
    await foregroundFixture(5, 110),
    fixtureManifest(),
  );

  assert.equal(evidence.total, 10);
  assert.equal(evidence.passedCount, 10);
  assert.equal(evidence.passed, true);
  assert.deepEqual(evidence.tolerance, {
    spanPx: TEXT_SPAN_TOLERANCE_PX,
    anchorPx: TEXT_ANCHOR_TOLERANCE_PX,
  });
  assert.ok(evidence.rows.every((row) => row.passed));
  assert.ok(evidence.rows.every((row) => row.spanDelta === 10));
  assert.ok(evidence.rows.every((row) => row.anchorDelta === 5));
});

test("rejects a text whose rendered horizontal span exceeds tolerance", async () => {
  const evidence = await measureTextSpanAcceptance(
    await foregroundFixture(0, 100),
    await foregroundFixture(TEXT_ANCHOR_TOLERANCE_PX + 1, 160),
    fixtureManifest(),
  );

  assert.equal(evidence.passed, false);
  assert.equal(evidence.passedCount, 0);
  assert.ok(
    evidence.rows.every(
      (row) => Math.abs(row.spanDelta) > TEXT_SPAN_TOLERANCE_PX,
    ),
  );
});
