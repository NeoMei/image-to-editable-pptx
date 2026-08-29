import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";

import {
  OUTPUT_OWNERSHIP_MARKER,
  publishOutputAtomically,
  validatePublicationTarget,
} from "../src/pipeline.js";

async function collectRelativeFiles(
  directory: string,
  prefix = "",
): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await collectRelativeFiles(path, relativePath));
    else if (entry.isFile()) paths.push(relativePath);
  }
  return paths;
}

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

test("rejects a symlinked failed-run directory before publication starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-publication-failed-root-"));
  const imagePath = join(directory, "source-slide-07.png");
  const targetPath = join(directory, "output");
  const external = join(directory, "external-failed-runs");

  try {
    await writeFile(imagePath, "source-image", "utf8");
    await mkdir(external);
    await symlink(external, `${targetPath}.failed-runs`);

    await assert.rejects(
      validatePublicationTarget({ targetPath, sourceImagePath: imagePath }),
      /Unsafe failed-run directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains four phase-specific failures without changing the prior successful publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-publication-phases-"));
  const imagePath = join(directory, "source.png");
  const targetPath = join(directory, "output");
  const phases = [
    "after-analysis",
    "after-one-accepted-layer",
    "during-qa-preview",
    "during-pptx-write",
  ] as const;
  const partialArtifact = {
    "after-analysis": "analysis-ledger.json",
    "after-one-accepted-layer": "assets/semantic-001.png",
    "during-qa-preview": "recomposition-preview.png.partial",
    "during-pptx-write": "slide-editable.pptx.partial",
  } as const;

  try {
    await writeFile(imagePath, "source-image", "utf8");
    await mkdir(targetPath);
    await Promise.all([
      writeFile(
        join(targetPath, OUTPUT_OWNERSHIP_MARKER),
        `${JSON.stringify({
          markerVersion: 1,
          appId: "image-to-editable-pptx",
          artifactKind: "published-output",
        })}\n`,
      ),
      writeFile(join(targetPath, "stable-success.txt"), "stable-success\n"),
    ]);
    const before = await readFile(join(targetPath, "stable-success.txt"), "utf8");

    for (const phase of phases) {
      await assert.rejects(
        publishOutputAtomically({
          targetPath,
          sourceImagePath: imagePath,
          build: async (stagingDirectory) => {
            const partialPath = join(stagingDirectory, partialArtifact[phase]);
            await mkdir(dirname(partialPath), { recursive: true });
            await writeFile(partialPath, `${phase}\n`);
            throw new Error(`injected failure: ${phase}`);
          },
        }),
        new RegExp(phase),
      );
      assert.equal(
        await readFile(join(targetPath, "stable-success.txt"), "utf8"),
        before,
      );
      assert.deepEqual((await readdir(targetPath)).sort(), [
        OUTPUT_OWNERSHIP_MARKER,
        "stable-success.txt",
      ].sort());
    }

    const failedRoot = `${targetPath}.failed-runs`;
    const failedRuns = await readdir(failedRoot);
    assert.equal(failedRuns.length, phases.length);
    const retainedArtifacts = (
      await Promise.all(
        failedRuns.map((failedRun) => collectRelativeFiles(join(failedRoot, failedRun))),
      )
    ).flat();
    for (const phase of phases) {
      assert.ok(retainedArtifacts.includes(partialArtifact[phase]), phase);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
