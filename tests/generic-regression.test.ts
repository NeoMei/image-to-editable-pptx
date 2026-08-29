import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";
import ts from "typescript";

import {
  chooseSemanticMask,
  deriveSemanticMasks,
} from "../src/image/semantic-mask.js";
import { decodeSourceImage } from "../src/image/source.js";
import type { SemanticCandidate } from "../src/scene/plan.js";

const FIXTURE_DIRECTORY = join("tests", "fixtures", "semantic");

const EXPECTED_FIXTURES = [
  { name: "canvas-16x9.png", format: "png", width: 320, height: 180 },
  { name: "canvas-4x3.jpg", format: "jpeg", width: 320, height: 240 },
  { name: "canvas-portrait.png", format: "png", width: 180, height: 320 },
  { name: "canvas-square.png", format: "png", width: 256, height: 256 },
  { name: "canvas-ultrawide.png", format: "png", width: 560, height: 80 },
  { name: "text-backing.png", format: "png", width: 320, height: 180 },
  { name: "connected-composition.png", format: "png", width: 320, height: 180 },
  { name: "occlusion.png", format: "png", width: 320, height: 180 },
  { name: "must-fallback.png", format: "png", width: 320, height: 180 },
] as const;

test("ships deterministic redistributable semantic fixtures with verified provenance", async () => {
  const provenance = JSON.parse(
    await readFile(join(FIXTURE_DIRECTORY, "provenance.json"), "utf8"),
  ) as {
    generatedBy: string;
    license: string;
    files: Record<string, { sha256: string; purpose: string }>;
  };

  assert.equal(provenance.generatedBy, "generate.mjs");
  assert.equal(provenance.license, "CC0-1.0");
  assert.deepEqual(Object.keys(provenance.files).sort(), EXPECTED_FIXTURES.map(({ name }) => name).sort());

  for (const expected of EXPECTED_FIXTURES) {
    const path = join(FIXTURE_DIRECTORY, expected.name);
    const bytes = await readFile(path);
    const metadata = await sharp(bytes).metadata();
    assert.deepEqual(
      { format: metadata.format, width: metadata.width, height: metadata.height },
      { format: expected.format, width: expected.width, height: expected.height },
      expected.name,
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      provenance.files[expected.name]?.sha256,
      `${expected.name} must match its provenance hash`,
    );
    assert.ok(provenance.files[expected.name]!.purpose.length >= 12);
  }
});

test("the dense negative fixture safely falls back instead of becoming a layer", async () => {
  const source = await decodeSourceImage(join(FIXTURE_DIRECTORY, "must-fallback.png"));
  const candidate: SemanticCandidate = {
    id: "dense-crossing-surface",
    kind: "foreground-object",
    nodeIds: ["dense-crossing-surface"],
    bbox: { x: 0, y: 0, width: source.width, height: source.height },
    zOrder: 1,
    relations: [],
    carriedTextIds: [],
  };
  const unrelatedTextMask = await sharp(Buffer.alloc(source.width * source.height), {
    raw: { width: source.width, height: source.height, channels: 1 },
  }).png().toBuffer();

  assert.equal(
    chooseSemanticMask(
      await deriveSemanticMasks(source, candidate),
      unrelatedTextMask,
    ),
    undefined,
  );
});

const DECISION_MODULES = [
  "src/planner.ts",
  "src/scene/plan.ts",
  "src/fidelity/candidates.ts",
  "src/fidelity/build.ts",
  "src/image/semantic-mask.ts",
  "src/fidelity/text-backing.ts",
  "src/occlusion/complete.ts",
] as const;

const ACCEPTANCE_ONLY_LABEL = /(?:slide[-_ ]?0?7|page[-_ ]?0?7|eye|radar|wrench|shield|眼睛|雷达|扳手|盾牌|安全机制)/i;

function branchExpressions(sourceFile: ts.SourceFile): ts.Expression[] {
  const expressions: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      expressions.push(node.expression);
    } else if (ts.isConditionalExpression(node)) {
      expressions.push(node.condition);
    } else if (ts.isCaseClause(node)) {
      expressions.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return expressions;
}

function isBBoxCoordinate(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (!/^(?:x|y|width|height)$/.test(node.name.text)) return false;
  return node.expression.getText().endsWith(".bbox") || node.expression.getText() === "bbox";
}

function containsFixedPixelCoordinate(expression: ts.Expression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isBinaryExpression(node)) {
      const leftNumber = ts.isNumericLiteral(node.left) && Number(node.left.text) > 1;
      const rightNumber = ts.isNumericLiteral(node.right) && Number(node.right.text) > 1;
      if ((isBBoxCoordinate(node.left) && rightNumber) || (leftNumber && isBBoxCoordinate(node.right))) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

test("generic decision modules contain no acceptance-specific branches or fixed 1280x720 math", async () => {
  const violations: string[] = [];
  for (const path of DECISION_MODULES) {
    const source = await readFile(path, "utf8");
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const expression of branchExpressions(sourceFile)) {
      const branchText = expression.getText(sourceFile);
      if (ACCEPTANCE_ONLY_LABEL.test(branchText)) {
        violations.push(`${path}:${sourceFile.getLineAndCharacterOfPosition(expression.getStart()).line + 1}: acceptance label in branch`);
      }
      if (/\b1280\b/.test(branchText) && /\b720\b/.test(branchText)) {
        violations.push(`${path}:${sourceFile.getLineAndCharacterOfPosition(expression.getStart()).line + 1}: hardcoded 1280x720 branch math`);
      }
      if (containsFixedPixelCoordinate(expression)) {
        violations.push(`${path}:${sourceFile.getLineAndCharacterOfPosition(expression.getStart()).line + 1}: fixed bbox pixel coordinate branch`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
