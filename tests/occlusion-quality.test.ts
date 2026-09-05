import assert from "node:assert/strict";
import test from "node:test";

import {
  assessHiddenCandidate,
  qualifyAppearance,
  type AppearanceInput,
} from "../src/occlusion/quality.js";
import type { CropRaster } from "../src/occlusion/request.js";
import { sourceLockedOcclusionFixture } from "./fixtures/occlusion/source-locked.js";

const SUPPORT = 255;

function crop(width: number, height: number, rgba: Buffer): CropRaster {
  return { width, height, rgba };
}

function inputFrom(
  fixture: Awaited<ReturnType<typeof sourceLockedOcclusionFixture>>,
  overrides: Partial<AppearanceInput> = {},
): AppearanceInput {
  const { width, height } = fixture.geometry.canvas;
  return {
    source: crop(width, height, fixture.rasters.original),
    visible: fixture.masks.visible,
    hidden: fixture.masks.hidden,
    occluder: fixture.masks.front,
    contacts: fixture.contacts,
    ...overrides,
  };
}

function returned(
  fixture: Awaited<ReturnType<typeof sourceLockedOcclusionFixture>>,
  rgba: Buffer,
): CropRaster {
  return crop(fixture.geometry.canvas.width, fixture.geometry.canvas.height, rgba);
}

function paintRgb(rgba: Buffer, index: number, color: readonly [number, number, number]): void {
  rgba.set(color, index * 4);
}

function recolor(
  rgba: Buffer,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): Buffer {
  const result = Buffer.from(rgba);
  for (let index = 0; index < result.length / 4; index += 1) {
    const offset = index * 4;
    if (
      result[offset] === from[0] &&
      result[offset + 1] === from[1] &&
      result[offset + 2] === from[2]
    ) {
      result.set(to, offset);
    }
  }
  return result;
}

function expectRejected(
  result: ReturnType<typeof assessHiddenCandidate>,
  reason: string,
): void {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail(`expected ${reason}`);
  assert.equal(result.reason, reason);
}

test("profiles source-local appearances and accepts only rear-classified hidden pixels", async () => {
  const fixture = await sourceLockedOcclusionFixture();
  const input = inputFrom(fixture);
  const snapshots = {
    source: Buffer.from(input.source.rgba),
    visible: Uint8Array.from(input.visible),
    hidden: Uint8Array.from(input.hidden),
    occluder: Uint8Array.from(input.occluder),
  };
  const validSnapshot = Buffer.from(fixture.rasters.valid);
  const qualification = qualifyAppearance(input);
  if (!qualification.ok) assert.fail(qualification.reason);
  assert.equal(qualification.ok, true);
  assert.deepEqual(qualification.profile, {
    rear: [40, 100, 160],
    front: [230, 90, 20],
    background: [247, 243, 233],
  });

  const accepted = assessHiddenCandidate({
    ...input,
    returned: returned(fixture, fixture.rasters.valid),
    profile: qualification.profile,
  });
  if (!accepted.ok) assert.fail(accepted.reason);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.metrics.generatedPixels, 64);
  assert.equal(accepted.metrics.residualPixels, 0);
  assert.ok(accepted.metrics.rearSamples >= 8);
  assert.ok(accepted.metrics.frontSamples >= 8);
  assert.ok(accepted.metrics.backgroundSamples >= 8);
  assert.equal(accepted.generated[3 * 32 + 15], 0);
  assert.equal(accepted.generated[10 * 32 + 15], 255);
  for (let index = 0; index < accepted.generated.length; index += 1) {
    if (accepted.generated[index] !== 0) assert.notEqual(input.hidden[index], 0);
  }

  const retainedFront = assessHiddenCandidate({
    ...input,
    returned: returned(fixture, fixture.rasters.retainedFront),
    profile: qualification.profile,
  });
  assert.equal(retainedFront.ok, false);
  if (retainedFront.ok) assert.fail("occluder must not become rear content");
  assert.equal(retainedFront.reason, "residual_occluder");
  assert.equal(retainedFront.metrics.residualPixels, 80);
  assert.deepEqual(input.source.rgba, snapshots.source);
  assert.deepEqual(input.visible, snapshots.visible);
  assert.deepEqual(input.hidden, snapshots.hidden);
  assert.deepEqual(input.occluder, snapshots.occluder);
  assert.deepEqual(fixture.rasters.valid, validSnapshot);
});

test("fails closed when source-local appearance evidence is insufficient or ambiguous", async () => {
  const fixture = await sourceLockedOcclusionFixture();
  const pixelCount = fixture.geometry.canvas.width * fixture.geometry.canvas.height;
  const sameColor = Buffer.from(fixture.rasters.original);
  for (let index = 0; index < pixelCount; index += 1) {
    if (fixture.masks.hidden[index] !== 0) paintRgb(sameColor, index, [40, 100, 160]);
  }
  const varied = Buffer.from(fixture.rasters.original);
  const gradient = Buffer.from(fixture.rasters.original);
  for (let index = 0; index < pixelCount; index += 1) {
    if (fixture.masks.rear[index] === 0 || fixture.masks.front[index] !== 0) continue;
    paintRgb(varied, index, index % 10 === 0 ? [47, 100, 160] : [40, 100, 160]);
    paintRgb(gradient, index, [40 + (index % 24), 100, 160]);
  }

  const cases: Array<{
    label: string;
    input: AppearanceInput;
    reason: "insufficient_evidence" | "ambiguous_appearance";
  }> = [
    {
      label: "no samples",
      input: inputFrom(fixture, { visible: new Uint8Array(pixelCount), contacts: [] }),
      reason: "insufficient_evidence",
    },
    {
      label: "one-sided contacts",
      input: inputFrom(fixture, { contacts: fixture.contacts.slice(0, 16) }),
      reason: "insufficient_evidence",
    },
    {
      label: "same-color rear and front",
      input: inputFrom(fixture, {
        source: returned(fixture, sameColor),
      }),
      reason: "ambiguous_appearance",
    },
    {
      label: "high-variation rear",
      input: inputFrom(fixture, { source: returned(fixture, varied) }),
      reason: "ambiguous_appearance",
    },
    {
      label: "gradient rear beyond scope",
      input: inputFrom(fixture, { source: returned(fixture, gradient) }),
      reason: "ambiguous_appearance",
    },
  ];

  for (const current of cases) {
    const result = qualifyAppearance(current.input);
    assert.equal(result.ok, false, current.label);
    if (result.ok) assert.fail(`${current.label} should reject`);
    assert.equal(result.reason, current.reason, current.label);
  }
});

test("freezes source p95 variation and palette-separation boundaries", async () => {
  const fixture = await sourceLockedOcclusionFixture();
  const pixelCount = fixture.geometry.canvas.width * fixture.geometry.canvas.height;

  for (const delta of [6, 7]) {
    const source = Buffer.from(fixture.rasters.original);
    for (let index = 0; index < pixelCount; index += 1) {
      if (fixture.masks.rear[index] !== 0 && fixture.masks.front[index] === 0 && index % 10 === 0) {
        paintRgb(source, index, [40 + delta, 100, 160]);
      }
    }
    const result = qualifyAppearance(inputFrom(fixture, { source: returned(fixture, source) }));
    assert.equal(result.ok, delta === 6, `rear p95 delta ${delta}`);
    if (!result.ok) assert.equal(result.reason, "ambiguous_appearance");
  }

  for (const separation of [36, 35]) {
    const source = Buffer.from(fixture.rasters.original);
    for (let index = 0; index < pixelCount; index += 1) {
      if (fixture.masks.hidden[index] !== 0) {
        paintRgb(source, index, [40 + separation, 100, 160]);
      }
    }
    const result = qualifyAppearance(inputFrom(fixture, { source: returned(fixture, source) }));
    assert.equal(result.ok, separation === 36, `palette separation ${separation}`);
    if (!result.ok) assert.equal(result.reason, "ambiguous_appearance");
  }
});

test("requires exactly eight opaque samples for each source appearance class", async () => {
  const fixture = await sourceLockedOcclusionFixture();
  const background = [
    2 * 32 + 12,
    3 * 32 + 12,
    20 * 32 + 12,
    21 * 32 + 12,
    2 * 32 + 19,
    3 * 32 + 19,
    20 * 32 + 19,
    21 * 32 + 19,
  ];
  for (const count of [8, 7]) {
    const source = Buffer.from(fixture.rasters.original);
    for (let index = 0; index < fixture.masks.hidden.length; index += 1) {
      if (fixture.masks.visible[index] === 0 && fixture.masks.front[index] === 0) {
        source[index * 4 + 3] = 0;
      }
    }
    for (const index of background.slice(0, count)) source[index * 4 + 3] = 255;
    const result = qualifyAppearance(inputFrom(fixture, { source: returned(fixture, source) }));
    assert.equal(result.ok, count === 8, `${count} background samples`);
    if (!result.ok) assert.equal(result.reason, "insufficient_evidence");
  }
});

test("classifies exact candidate and alpha boundaries conservatively", async () => {
  const fixture = await sourceLockedOcclusionFixture();
  const input = inputFrom(fixture);
  const qualification = qualifyAppearance(input);
  if (!qualification.ok) assert.fail(qualification.reason);
  assert.equal(qualification.ok, true);

  for (const current of [
    { label: "candidate delta 12", delta: 12, alpha: 255, ok: true },
    { label: "candidate delta 13", delta: 13, alpha: 255, ok: false },
    { label: "opaque alpha 240", delta: 0, alpha: 240, ok: true },
    { label: "alpha fringe 239", delta: 0, alpha: 239, ok: false },
  ]) {
    const candidate = Buffer.from(fixture.rasters.valid);
    for (let index = 0; index < input.hidden.length; index += 1) {
      if (input.hidden[index] === 0 || fixture.masks.rear[index] === 0) continue;
      const offset = index * 4;
      candidate.set([40 + current.delta, 100 + current.delta, 160 + current.delta, current.alpha], offset);
    }
    const result = assessHiddenCandidate({
      ...input,
      returned: returned(fixture, candidate),
      profile: qualification.profile,
    });
    assert.equal(result.ok, current.ok, current.label);
    if (!result.ok) assert.equal(result.reason, "ambiguous_appearance", current.label);
  }

  const tied = assessHiddenCandidate({
    ...input,
    returned: returned(fixture, fixture.rasters.valid),
    profile: {
      ...qualification.profile,
      front: qualification.profile.rear,
    },
  });
  expectRejected(tied, "ambiguous_appearance");

  const transparent = Buffer.from(fixture.rasters.valid);
  for (let index = 0; index < input.hidden.length; index += 1) {
    if (input.hidden[index] !== 0) transparent.fill(0, index * 4, index * 4 + 4);
  }
  const noGeneratedSupport = assessHiddenCandidate({
    ...input,
    returned: returned(fixture, transparent),
    profile: qualification.profile,
  });
  expectRejected(noGeneratedSupport, "contour_mismatch");
  assert.equal(noGeneratedSupport.metrics.generatedPixels, 0);
});

test("rejects labeled residual, wrong-color, missing, seam and contour cases", async () => {
  const fixture = await sourceLockedOcclusionFixture();
  const input = inputFrom(fixture);
  const qualification = qualifyAppearance(input);
  if (!qualification.ok) assert.fail(qualification.reason);
  assert.equal(qualification.ok, true);

  const cases = [
    { label: fixture.labels.retainedFront, rgba: fixture.rasters.retainedFront, reason: "residual_occluder" },
    { label: "shaded front", rgba: fixture.rasters.shadedFront, reason: "residual_occluder" },
    { label: fixture.labels.wrongColor, rgba: fixture.rasters.greenRear, reason: "ambiguous_appearance" },
    { label: fixture.labels.backgroundOnly, rgba: fixture.rasters.backgroundOnly, reason: "contour_mismatch" },
    { label: fixture.labels.shifted, rgba: fixture.rasters.shiftedRear, reason: "contour_mismatch" },
    { label: fixture.labels.seam, rgba: fixture.rasters.seam, reason: "ambiguous_appearance" },
    { label: fixture.labels.disconnected, rgba: fixture.rasters.disconnectedIsland, reason: "contour_mismatch" },
  ] as const;

  for (const current of cases) {
    const result = assessHiddenCandidate({
      ...input,
      returned: returned(fixture, current.rgba),
      profile: qualification.profile,
    });
    expectRejected(result, current.reason);
  }


  const glowingEdge = Buffer.from(fixture.rasters.valid);
  for (let y = 4; y <= 19; y += 1) {
    glowingEdge[(y * 32 + 14) * 4 + 3] = 200;
  }
  const glowing = assessHiddenCandidate({
    ...input,
    returned: returned(fixture, glowingEdge),
    profile: qualification.profile,
  });
  expectRejected(glowing, "ambiguous_appearance");
});

test("checks seam delta at 12 and rejects one level beyond", async () => {
  const fixture = await sourceLockedOcclusionFixture();
  for (const candidateDelta of [6, 7]) {
    const source = Buffer.from(fixture.rasters.original);
    const candidate = Buffer.from(fixture.rasters.valid);
    for (const y of [9, 10]) {
      for (const x of [13, 18]) paintRgb(source, y * 32 + x, [34, 94, 154]);
      for (const x of [14, 17]) paintRgb(candidate, y * 32 + x, [40 + candidateDelta, 100 + candidateDelta, 160 + candidateDelta]);
    }
    for (let index = 0; index < fixture.masks.hidden.length; index += 1) {
      if (fixture.masks.hidden[index] === 0) {
        candidate.set(source.subarray(index * 4, index * 4 + 4), index * 4);
      }
    }
    const input = inputFrom(fixture, { source: returned(fixture, source) });
    const qualification = qualifyAppearance(input);
    if (!qualification.ok) assert.fail(qualification.reason);
    assert.equal(qualification.ok, true);
    const result = assessHiddenCandidate({
      ...input,
      returned: returned(fixture, candidate),
      profile: qualification.profile,
    });
    assert.equal(result.ok, candidateDelta === 6, `seam delta ${candidateDelta + 6}`);
    if (!result.ok) assert.equal(result.reason, "seam_mismatch");
  }
});

test("ignores diagonal source alpha fringes while accepting varied palettes and scales", async () => {
  const fixture = await sourceLockedOcclusionFixture();
  const fringedSource = Buffer.from(fixture.rasters.original);
  for (const index of [4 * 32 + 4, 4 * 32 + 5, 5 * 32 + 4, 18 * 32 + 27, 19 * 32 + 26, 19 * 32 + 27]) {
    fringedSource[index * 4 + 3] = 120;
  }
  const fringedInput = inputFrom(fixture, { source: returned(fixture, fringedSource) });
  const fringedProfile = qualifyAppearance(fringedInput);
  if (!fringedProfile.ok) assert.fail(fringedProfile.reason);
  assert.equal(fringedProfile.ok, true);
  const fringeAccepted = assessHiddenCandidate({
    ...fringedInput,
    returned: returned(fixture, fixture.rasters.valid),
    profile: fringedProfile.profile,
  });
  assert.equal(fringeAccepted.ok, true);

  const palette = {
    rear: [90, 40, 170] as const,
    front: [15, 190, 40] as const,
    background: [230, 220, 170] as const,
  };
  let source = recolor(fixture.rasters.original, [40, 100, 160], palette.rear);
  source = recolor(source, [230, 90, 20], palette.front);
  source = recolor(source, [247, 243, 233], palette.background);
  let candidate = recolor(fixture.rasters.valid, [40, 100, 160], palette.rear);
  candidate = recolor(candidate, [230, 90, 20], palette.front);
  candidate = recolor(candidate, [247, 243, 233], palette.background);
  const paletteInput = inputFrom(fixture, { source: returned(fixture, source) });
  const paletteProfile = qualifyAppearance(paletteInput);
  if (!paletteProfile.ok) assert.fail(paletteProfile.reason);
  assert.equal(paletteProfile.ok, true);
  assert.deepEqual(paletteProfile.profile, palette);
  const accepted = assessHiddenCandidate({
    ...paletteInput,
    returned: returned(fixture, candidate),
    profile: paletteProfile.profile,
  });
  assert.equal(accepted.ok, true);

  const scale = 2;
  const width = 64;
  const height = 48;
  const scaleRgba = (rgba: Buffer): Buffer => {
    const result = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourceOffset = (Math.floor(y / scale) * 32 + Math.floor(x / scale)) * 4;
        rgba.copy(result, (y * width + x) * 4, sourceOffset, sourceOffset + 4);
      }
    }
    return result;
  };
  const scaleMask = (mask: Uint8Array): Uint8Array => {
    const result = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) result[y * width + x] = mask[Math.floor(y / scale) * 32 + Math.floor(x / scale)]!;
    }
    return result;
  };
  const contacts = [
    ...Array.from({ length: 32 }, (_, offset) => (offset + 8) * width + 27),
    ...Array.from({ length: 32 }, (_, offset) => (offset + 8) * width + 36),
  ];
  const scaledInput: AppearanceInput = {
    source: crop(width, height, scaleRgba(fixture.rasters.original)),
    visible: scaleMask(fixture.masks.visible),
    hidden: scaleMask(fixture.masks.hidden),
    occluder: scaleMask(fixture.masks.front),
    contacts,
  };
  const scaledProfile = qualifyAppearance(scaledInput);
  if (!scaledProfile.ok) assert.fail(scaledProfile.reason);
  assert.equal(scaledProfile.ok, true);
  const scaled = assessHiddenCandidate({
    ...scaledInput,
    returned: crop(width, height, scaleRgba(fixture.rasters.valid)),
    profile: scaledProfile.profile,
  });
  if (!scaled.ok) assert.fail(scaled.reason);
  assert.equal(scaled.ok, true);
  assert.equal(scaled.metrics.generatedPixels, 256);
});

test("reports geometry failures and returned-change diagnostics without copying them", async () => {
  const fixture = await sourceLockedOcclusionFixture();
  const input = inputFrom(fixture);
  const qualification = qualifyAppearance(input);
  if (!qualification.ok) assert.fail(qualification.reason);
  assert.equal(qualification.ok, true);

  const changed = Buffer.from(fixture.rasters.valid);
  changed.set([1, 2, 3, 255], 0);
  changed.set([9, 8, 7, 255], (10 * 32 + 4) * 4);
  const diagnostic = assessHiddenCandidate({
    ...input,
    returned: returned(fixture, changed),
    profile: qualification.profile,
  });
  if (!diagnostic.ok) assert.fail(diagnostic.reason);
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.metrics.returnedOutsideChangedPixels, 2);
  assert.equal(diagnostic.metrics.returnedVisibleChangedPixels, 1);

  const wrongGeometry = assessHiddenCandidate({
    ...input,
    returned: crop(31, 24, Buffer.alloc(31 * 24 * 4)),
    profile: qualification.profile,
  });
  expectRejected(wrongGeometry, "geometry");

  const invalidMask = qualifyAppearance({
    ...input,
    hidden: new Uint8Array(input.hidden.length - 1),
  });
  assert.equal(invalidMask.ok, false);
  if (invalidMask.ok) assert.fail("invalid mask geometry must reject");
  assert.equal(invalidMask.reason, "geometry");
});
