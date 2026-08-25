import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";

import { validatePublicationTarget } from "../src/pipeline.js";

test("rejects dangerous publication paths even when marked or reached through a symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-publication-safety-"));
  const imagePath = join(directory, "source-slide-07.png");
  const cwdAlias = join(directory, "cwd-alias");

  try {
    await writeFile(imagePath, "source-image", "utf8");
    await writeFile(
      join(directory, ".image-ppt-layers-output.json"),
      `${JSON.stringify({
        markerVersion: 1,
        appId: "image-ppt-layers",
        artifactKind: "published-output",
      })}\n`,
      "utf8",
    );
    await symlink(process.cwd(), cwdAlias);

    const dangerousTargets = [
      "",
      ".",
      parse(process.cwd()).root,
      dirname(process.cwd()),
      imagePath,
      directory,
      cwdAlias,
    ];
    for (const targetPath of dangerousTargets) {
      await assert.rejects(
        validatePublicationTarget({
          targetPath,
          sourceImagePath: imagePath,
        }),
        /Unsafe output directory/,
        `expected dangerous path to be rejected: ${targetPath || "<empty>"}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not accept a symlinked ownership marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-publication-marker-"));
  const imagePath = join(directory, "source-slide-07.png");
  const targetPath = join(directory, "output");
  const externalMarker = join(directory, "external-marker.json");

  try {
    await writeFile(imagePath, "source-image", "utf8");
    await mkdir(targetPath);
    await writeFile(
      externalMarker,
      `${JSON.stringify({
        markerVersion: 1,
        appId: "image-ppt-layers",
        artifactKind: "published-output",
      })}\n`,
      "utf8",
    );
    await symlink(
      externalMarker,
      join(targetPath, ".image-ppt-layers-output.json"),
    );

    await assert.rejects(
      validatePublicationTarget({ targetPath, sourceImagePath: imagePath }),
      /Refusing to replace unowned output directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
