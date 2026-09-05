import sharp from "sharp";

const WIDTH = 32;
const HEIGHT = 24;
const CREAM = [247, 243, 233, 255] as const;
const BLUE = [40, 100, 160, 255] as const;
const ORANGE = [230, 90, 20, 255] as const;
const GREEN = [30, 180, 80, 255] as const;
const BLACK = [0, 0, 0, 255] as const;

export type SourceLockedOcclusionFixture = Awaited<
  ReturnType<typeof sourceLockedOcclusionFixture>
>;

type Rect = { x: number; y: number; width: number; height: number };

function paint(
  rgba: Buffer,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  rgba.set(color, (y * WIDTH + x) * 4);
}

function png(rgba: Buffer): Promise<Buffer> {
  return sharp(rgba, {
    raw: { width: WIDTH, height: HEIGHT, channels: 4 },
  }).png().toBuffer();
}

export async function sourceLockedOcclusionFixture() {
  const originalRgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  const rearMask = new Uint8Array(WIDTH * HEIGHT);
  const visibleMask = new Uint8Array(WIDTH * HEIGHT);
  const frontMask = new Uint8Array(WIDTH * HEIGHT);
  const hiddenMask = new Uint8Array(WIDTH * HEIGHT);

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) paint(originalRgba, x, y, CREAM);
  }
  for (let y = 4; y <= 19; y += 1) {
    for (let x = 4; x <= 27; x += 1) {
      paint(originalRgba, x, y, BLUE);
      rearMask[y * WIDTH + x] = 255;
    }
  }
  for (let y = 2; y <= 21; y += 1) {
    for (let x = 14; x <= 17; x += 1) {
      paint(originalRgba, x, y, ORANGE);
      frontMask[y * WIDTH + x] = 255;
      hiddenMask[y * WIDTH + x] = 255;
    }
  }
  for (let index = 0; index < rearMask.length; index += 1) {
    if (rearMask[index] !== 0 && frontMask[index] === 0) visibleMask[index] = 255;
  }
  const contacts = [
    ...Array.from({ length: 16 }, (_, offset) => (offset + 4) * WIDTH + 13),
    ...Array.from({ length: 16 }, (_, offset) => (offset + 4) * WIDTH + 18),
  ];

  const clearedRgba = Buffer.from(originalRgba);
  const validRgba = Buffer.from(originalRgba);
  const shiftedRearRgba = Buffer.from(originalRgba);
  const greenRearRgba = Buffer.from(originalRgba);
  const backgroundOnlyRgba = Buffer.from(originalRgba);
  const shadedFrontRgba = Buffer.from(originalRgba);
  const disconnectedIslandRgba = Buffer.from(originalRgba);
  const calibratedValidRgba = Buffer.from(originalRgba);
  const nearRearImpostorRgba = Buffer.from(originalRgba);
  const glowingEdgeRgba = Buffer.from(originalRgba);
  const mildVariationSourceRgba = Buffer.from(originalRgba);
  const roughVariationSourceRgba = Buffer.from(originalRgba);
  const closePaletteSourceRgba = Buffer.from(originalRgba);
  const enoughContextSourceRgba = Buffer.from(originalRgba);
  const sparseContextSourceRgba = Buffer.from(originalRgba);
  const seamCalibrationSourceRgba = Buffer.from(originalRgba);
  const softSeamRgba = Buffer.from(originalRgba);
  const hardSeamRgba = Buffer.from(originalRgba);
  const seamRgba = Buffer.from(originalRgba);
  for (let y = 2; y <= 21; y += 1) {
    for (let x = 14; x <= 17; x += 1) {
      paint(clearedRgba, x, y, [0, 0, 0, 0]);
      const isRearIntersection = y >= 4 && y <= 19;
      paint(validRgba, x, y, isRearIntersection ? BLUE : CREAM);
      paint(greenRearRgba, x, y, isRearIntersection ? GREEN : CREAM);
      paint(backgroundOnlyRgba, x, y, CREAM);
      paint(shadedFrontRgba, x, y, [222, 98, 28, 255]);
      paint(calibratedValidRgba, x, y, isRearIntersection ? BLUE : CREAM);
      paint(nearRearImpostorRgba, x, y, isRearIntersection ? BLUE : CREAM);
      paint(glowingEdgeRgba, x, y, isRearIntersection ? BLUE : CREAM);
      const isShiftedRear = y >= 8 && y <= 21;
      paint(shiftedRearRgba, x, y, isShiftedRear ? BLUE : CREAM);
      paint(seamRgba, x, y, isRearIntersection ? BLUE : CREAM);
    }
  }
  for (let y = 5; y <= 18; y += 1) {
    for (const x of [15, 16]) {
      paint(calibratedValidRgba, x, y, y % 2 === 0 ? [44, 97, 156, 246] : [37, 104, 162, 246]);
      paint(nearRearImpostorRgba, x, y, [57, 117, 177, 255]);
    }
  }
  for (let y = 4; y <= 19; y += 1) {
    for (let x = 14; x <= 17; x += 1) {
      calibratedValidRgba[(y * WIDTH + x) * 4 + 3] = 246;
    }
  }
  for (let y = 4; y <= 19; y += 1) {
    paint(glowingEdgeRgba, 14, y, [40, 100, 160, 218]);
  }
  for (let index = 0; index < rearMask.length; index += 1) {
    if (visibleMask[index] !== 0 && index % 10 === 0) {
      paint(mildVariationSourceRgba, index % WIDTH, Math.floor(index / WIDTH), [44, 100, 160, 255]);
      paint(roughVariationSourceRgba, index % WIDTH, Math.floor(index / WIDTH), [54, 100, 160, 255]);
    }
    if (hiddenMask[index] !== 0) {
      paint(closePaletteSourceRgba, index % WIDTH, Math.floor(index / WIDTH), [68, 100, 160, 255]);
    }
  }
  const backgroundContext = [
    2 * WIDTH + 11, 2 * WIDTH + 12, 3 * WIDTH + 11, 3 * WIDTH + 12,
    20 * WIDTH + 11, 21 * WIDTH + 12, 2 * WIDTH + 19, 3 * WIDTH + 20,
    20 * WIDTH + 19, 21 * WIDTH + 20,
  ];
  for (let index = 0; index < rearMask.length; index += 1) {
    if (visibleMask[index] === 0 && frontMask[index] === 0) {
      enoughContextSourceRgba[index * 4 + 3] = 0;
      sparseContextSourceRgba[index * 4 + 3] = 0;
    }
  }
  for (const index of backgroundContext) enoughContextSourceRgba[index * 4 + 3] = 255;
  for (const index of backgroundContext.slice(0, 6)) sparseContextSourceRgba[index * 4 + 3] = 255;
  seamCalibrationSourceRgba.set(originalRgba);
  softSeamRgba.set(validRgba);
  hardSeamRgba.set(validRgba);
  for (const contact of contacts) {
    paint(seamCalibrationSourceRgba, contact % WIDTH, Math.floor(contact / WIDTH), [36, 96, 156, 255]);
    const x = contact % WIDTH === 13 ? 14 : 17;
    const y = Math.floor(contact / WIDTH);
    paint(softSeamRgba, x, y, [44, 104, 164, 255]);
    paint(hardSeamRgba, x, y, [50, 110, 170, 255]);
  }
  for (let x = 14; x <= 17; x += 1) paint(seamRgba, x, 4, BLACK);
  disconnectedIslandRgba.set(validRgba);
  paint(disconnectedIslandRgba, 15, 2, BLUE);

  const geometry = {
    canvas: { width: WIDTH, height: HEIGHT },
    rear: { x: 4, y: 4, width: 24, height: 16 } satisfies Rect,
    front: { x: 14, y: 2, width: 4, height: 20 } satisfies Rect,
    rearFrontIntersection: { x: 14, y: 4, width: 4, height: 16 } satisfies Rect,
  } as const;

  return {
    geometry,
    labels: {
      accepted: "uniform rear continuation",
      retainedFront: "unchanged front occluder",
      backgroundOnly: "background-only hidden return",
      wrongColor: "separable non-source color",
      shifted: "rear-colored support shifted off contacts",
      seam: "unclassifiable one-pixel contact seam",
      disconnected: "rear-colored disconnected island",
      calibrationPositive: "subtly varied rear continuation",
      calibrationImpostor: "near-rear uniform impostor interior",
      calibrationGlow: "semi-opaque glowing contact edge",
      calibrationMildSource: "mildly varied source rear",
      calibrationRoughSource: "rough source rear beyond flat-color scope",
      calibrationClosePalette: "rear and front palettes too close to distinguish",
      calibrationEnoughContext: "ten local background context samples",
      calibrationSparseContext: "six local background context samples",
      calibrationSoftSeam: "bounded eight-level continuation seam",
      calibrationHardSeam: "visible fourteen-level continuation seam",
    },
    contacts,
    masks: { rear: rearMask, visible: visibleMask, front: frontMask, hidden: hiddenMask },
    rasters: {
      original: originalRgba,
      cleared: clearedRgba,
      valid: validRgba,
      retainedFront: Buffer.from(originalRgba),
      shiftedRear: shiftedRearRgba,
      greenRear: greenRearRgba,
      backgroundOnly: backgroundOnlyRgba,
      shadedFront: shadedFrontRgba,
      disconnectedIsland: disconnectedIslandRgba,
      calibratedValid: calibratedValidRgba,
      nearRearImpostor: nearRearImpostorRgba,
      glowingEdge: glowingEdgeRgba,
      mildVariationSource: mildVariationSourceRgba,
      roughVariationSource: roughVariationSourceRgba,
      closePaletteSource: closePaletteSourceRgba,
      enoughContextSource: enoughContextSourceRgba,
      sparseContextSource: sparseContextSourceRgba,
      seamCalibrationSource: seamCalibrationSourceRgba,
      softSeam: softSeamRgba,
      hardSeam: hardSeamRgba,
      seam: seamRgba,
    },
    pngs: {
      original: await png(originalRgba),
      cleared: await png(clearedRgba),
      valid: await png(validRgba),
      retainedFront: await png(originalRgba),
      shiftedRear: await png(shiftedRearRgba),
      greenRear: await png(greenRearRgba),
      backgroundOnly: await png(backgroundOnlyRgba),
      shadedFront: await png(shadedFrontRgba),
      disconnectedIsland: await png(disconnectedIslandRgba),
      calibratedValid: await png(calibratedValidRgba),
      nearRearImpostor: await png(nearRearImpostorRgba),
      glowingEdge: await png(glowingEdgeRgba),
      mildVariationSource: await png(mildVariationSourceRgba),
      roughVariationSource: await png(roughVariationSourceRgba),
      closePaletteSource: await png(closePaletteSourceRgba),
      enoughContextSource: await png(enoughContextSourceRgba),
      sparseContextSource: await png(sparseContextSourceRgba),
      seamCalibrationSource: await png(seamCalibrationSourceRgba),
      softSeam: await png(softSeamRgba),
      hardSeam: await png(hardSeamRgba),
      seam: await png(seamRgba),
    },
  };
}
