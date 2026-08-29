import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  assertSupportedCanvas,
  decodeSourceImage,
} from "../src/image/source.js";

async function withFixtureDirectory(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ppt-source-image-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeFixture(
  directory: string,
  name: string,
  width: number,
  height: number,
  format: "png" | "jpeg",
): Promise<{ path: string; sourceBytes: Buffer }> {
  const sourceBytes = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 0.5 },
    },
  })[format]().toBuffer();
  const path = join(directory, name);
  await writeFile(path, sourceBytes);
  return { path, sourceBytes };
}

test("decodes a PNG fixture into its canonical RGBA canvas", async () => {
  await withFixtureDirectory(async (directory) => {
    const fixture = await writeFixture(directory, "source.png", 96, 64, "png");

    const source = await decodeSourceImage(fixture.path);

    assert.equal(source.format, "png");
    assert.equal(source.width, 96);
    assert.equal(source.height, 64);
    assert.equal(source.rgba.length, 96 * 64 * 4);
    assert.deepEqual(source.sourceBytes, fixture.sourceBytes);
    assert.equal(source.rgba[3], 128);
  });
});

test("decodes a JPEG fixture and ignores a misleading extension", async () => {
  await withFixtureDirectory(async (directory) => {
    const fixture = await writeFixture(directory, "source.png", 96, 64, "jpeg");

    const source = await decodeSourceImage(fixture.path);

    assert.equal(source.format, "jpeg");
    assert.equal(source.width, 96);
    assert.equal(source.height, 64);
    assert.equal(source.rgba.length, 96 * 64 * 4);
    assert.equal(source.rgba[3], 255);
  });
});

test("rejects unsupported magic bytes and corrupt supported input", async () => {
  await withFixtureDirectory(async (directory) => {
    const unsupportedPath = join(directory, "source.png");
    const corruptPngPath = join(directory, "corrupt.png");
    await Promise.all([
      writeFile(unsupportedPath, Buffer.from("GIF89a")),
      writeFile(corruptPngPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    ]);

    await assert.rejects(decodeSourceImage(unsupportedPath), /PNG or JPEG/i);
    await assert.rejects(decodeSourceImage(corruptPngPath), /decode|corrupt|invalid/i);
  });
});

test("rejects source files larger than 50 MiB before decoding", async () => {
  await withFixtureDirectory(async (directory) => {
    const path = join(directory, "oversized.png");
    await writeFile(path, Buffer.alloc(50 * 1024 * 1024 + 1));

    await assert.rejects(decodeSourceImage(path), /50 MiB/);
  });
});

test("rejects canvases outside the supported dimension, pixel, and aspect-ratio bounds", async () => {
  assert.throws(() => assertSupportedCanvas(63, 720), /at least 64 pixels/);
  assert.throws(() => assertSupportedCanvas(8193, 720), /at most 8192 pixels/);
  assert.throws(() => assertSupportedCanvas(8192, 8192), /40,000,000 pixels/);
  assert.throws(() => assertSupportedCanvas(64, 3585), /56:1/);
});
