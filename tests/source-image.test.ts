import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import sharp from "sharp";

import { decodeSourceImage } from "../src/image/source.js";

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

function crc32(bytes: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum =
        (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

async function writeMetadataOnlyPngFixture(
  directory: string,
  name: string,
  width: number,
  height: number,
): Promise<string> {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const path = join(directory, name);
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
  return path;
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

test("rejects out-of-range canvas metadata before raw decoding", async () => {
  await withFixtureDirectory(async (directory) => {
    const [narrowFixture, wideFixture, tooWideAspectFixture, tooManyPixels] = await Promise.all([
      writeFixture(directory, "source-63x720.png", 63, 720, "png"),
      writeFixture(directory, "source-8193x720.png", 8193, 720, "png"),
      writeFixture(directory, "source-64x3585.png", 64, 3585, "png"),
      writeMetadataOnlyPngFixture(directory, "source-8192x8192.png", 8192, 8192),
    ]);

    await assert.rejects(decodeSourceImage(narrowFixture.path), /at least 64 pixels/);
    await assert.rejects(decodeSourceImage(wideFixture.path), /at most 8192 pixels/);
    await assert.rejects(decodeSourceImage(tooManyPixels), /40,000,000 pixels/);
    await assert.rejects(decodeSourceImage(tooWideAspectFixture.path), /56:1/);
  });
});

test("accepts source canvas boundaries through canonical decoding", async () => {
  await withFixtureDirectory(async (directory) => {
    const [minimum, maximumWidth, exactAspectRatio] = await Promise.all([
      writeFixture(directory, "source-64x64.png", 64, 64, "png"),
      writeFixture(directory, "source-8192x147.png", 8192, 147, "png"),
      writeFixture(directory, "source-3584x64.png", 3584, 64, "png"),
    ]);

    const sources = await Promise.all([
      decodeSourceImage(minimum.path),
      decodeSourceImage(maximumWidth.path),
      decodeSourceImage(exactAspectRatio.path),
    ]);

    assert.deepEqual(
      sources.map((source) => [source.width, source.height]),
      [[64, 64], [8192, 147], [3584, 64]],
    );
  });
});
