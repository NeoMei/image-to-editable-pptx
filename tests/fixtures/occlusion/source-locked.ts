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

  const clearedRgba = Buffer.from(originalRgba);
  const validRgba = Buffer.from(originalRgba);
  const shiftedRearRgba = Buffer.from(originalRgba);
  const greenRearRgba = Buffer.from(originalRgba);
  const seamRgba = Buffer.from(originalRgba);
  for (let y = 2; y <= 21; y += 1) {
    for (let x = 14; x <= 17; x += 1) {
      paint(clearedRgba, x, y, [0, 0, 0, 0]);
      const isRearIntersection = y >= 4 && y <= 19;
      paint(validRgba, x, y, isRearIntersection ? BLUE : CREAM);
      paint(greenRearRgba, x, y, isRearIntersection ? GREEN : CREAM);
      const isShiftedRear = y >= 8 && y <= 21;
      paint(shiftedRearRgba, x, y, isShiftedRear ? BLUE : CREAM);
      paint(seamRgba, x, y, isRearIntersection ? BLUE : CREAM);
    }
  }
  for (let x = 14; x <= 17; x += 1) paint(seamRgba, x, 4, BLACK);

  const geometry = {
    canvas: { width: WIDTH, height: HEIGHT },
    rear: { x: 4, y: 4, width: 24, height: 16 } satisfies Rect,
    front: { x: 14, y: 2, width: 4, height: 20 } satisfies Rect,
    rearFrontIntersection: { x: 14, y: 4, width: 4, height: 16 } satisfies Rect,
  } as const;

  return {
    geometry,
    masks: { rear: rearMask, front: frontMask, hidden: hiddenMask },
    rasters: {
      original: originalRgba,
      cleared: clearedRgba,
      valid: validRgba,
      retainedFront: Buffer.from(originalRgba),
      shiftedRear: shiftedRearRgba,
      greenRear: greenRearRgba,
      seam: seamRgba,
    },
    pngs: {
      original: await png(originalRgba),
      cleared: await png(clearedRgba),
      valid: await png(validRgba),
      retainedFront: await png(originalRgba),
      shiftedRear: await png(shiftedRearRgba),
      greenRear: await png(greenRearRgba),
      seam: await png(seamRgba),
    },
  };
}
