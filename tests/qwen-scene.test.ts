import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import type { AppConfig } from "../src/config.js";
import {
  analyzeScene,
  parseQwenSceneContent,
} from "../src/providers/qwen-scene.js";
import type { ProviderResponseObserver } from "../src/providers/response-observer.js";

const config: AppConfig = {
  apiKey: "offline-scene-secret",
  workspaceId: "workspace-123",
  dashscopeApiBase:
    "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1",
  dashscopeCompatibleBase:
    "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  ocrModel: "qwen3.5-ocr",
  visionModel: "qwen3-vl-plus",
  editModel: "wanx2.1-imageedit",
  requestTimeoutMs: 120_000,
  pollIntervalMs: 2_000,
};

type SceneFixture = {
  choices: Array<{ message: { content: string } }>;
};

async function readFixture(): Promise<SceneFixture> {
  return JSON.parse(
    await readFile(
      resolve("tests/fixtures/qwen-scene-generic.json"),
      "utf8",
    ),
  ) as SceneFixture;
}

function parseFixturePayload(fixture: SceneFixture): {
  nodes: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
} {
  return JSON.parse(fixture.choices[0]!.message.content) as {
    nodes: Array<Record<string, unknown>>;
    relations: Array<Record<string, unknown>>;
  };
}

function completionWithContent(content: string): object {
  return {
    id: "offline-scene-completion",
    object: "chat.completion",
    created: 0,
    model: config.visionModel,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function createObserver(): {
  observer: ProviderResponseObserver;
  rawResponses: unknown[];
  rawHttpResponses: string[];
  parseErrors: unknown[];
} {
  const rawResponses: unknown[] = [];
  const rawHttpResponses: string[] = [];
  const parseErrors: unknown[] = [];
  return {
    observer: {
      async recordRawResponse(payload) {
        rawResponses.push(payload);
      },
      async recordRawHttpResponse(body) {
        rawHttpResponses.push(body);
      },
      async recordParseError(error) {
        parseErrors.push(error);
      },
    },
    rawResponses,
    rawHttpResponses,
    parseErrors,
  };
}

const ACCEPTANCE_TOKENS = [
  "\u773c\u775b",
  "\u96f7\u8fbe",
  "\u6273\u624b",
  "\u76fe\u724c",
  "\u5b89\u5168\u673a\u5236",
  "slide-07",
];

function findSceneArchitectureViolations(
  sourceText: string,
  modulePath = "scene-decision.ts",
): string[] {
  const source = ts.createSourceFile(
    modulePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const decisionExpressions: ts.Expression[] = [];
  const violations: string[] = [];

  function isPromptProducingSubtree(node: ts.Node): boolean {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node)) &&
      node.name !== undefined &&
      /prompt/i.test(node.name.getText(source))
    ) {
      return true;
    }

    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name) &&
      /prompt/i.test(node.parent.name.text)
    ) {
      return true;
    }

    return (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /prompt/i.test(node.name.text)
    );
  }

  function visit(node: ts.Node): void {
    if (isPromptProducingSubtree(node)) return;

    if (
      ts.isIfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node)
    ) {
      decisionExpressions.push(node.expression);
    } else if (ts.isConditionalExpression(node)) {
      decisionExpressions.push(node.condition);
    } else if (ts.isForStatement(node) && node.condition !== undefined) {
      decisionExpressions.push(node.condition);
    } else if (ts.isCaseClause(node)) {
      decisionExpressions.push(node.expression);
    }

    ts.forEachChild(node, visit);
  }

  visit(source);

  for (const expression of decisionExpressions) {
    const expressionText = expression.getText(source);
    if (/(?:\.label\b|\[\s*["']label["']\s*\])/.test(expressionText)) {
      violations.push("branch on audit-only label");
    }
    function inspectDecisionLiteral(node: ts.Node): void {
      if (ts.isNumericLiteral(node)) {
        const value = Number(node.text);
        if (value === 1280 || value === 720) {
          violations.push(`fixed-canvas numeric geometry: ${value}`);
        }
      }
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        for (const token of ACCEPTANCE_TOKENS) {
          if (node.text.includes(token)) {
            violations.push(`branch on acceptance token: ${token}`);
          }
        }
      }
      ts.forEachChild(node, inspectDecisionLiteral);
    }

    inspectDecisionLiteral(expression);
  }

  return violations;
}

test("parses every generic scene role and relation on an arbitrary canvas", async () => {
  const fixture = await readFixture();
  const graph = parseQwenSceneContent(fixture.choices[0]!.message.content, {
    width: 1377,
    height: 811,
  });

  assert.equal(graph.graphVersion, 1);
  assert.deepEqual(graph.canvas, { width: 1377, height: 811 });
  assert.deepEqual(
    graph.nodes.map((node) => node.role).sort(),
    [
      "background",
      "compound-group",
      "connector",
      "decoration",
      "foreground-object",
      "text",
      "text-backing",
    ].sort(),
  );
  assert.deepEqual(
    graph.relations.map((relation) => relation.kind).sort(),
    [
      "behind",
      "belongs-to",
      "carries-text",
      "connected-to",
      "in-front-of",
      "occludes",
    ].sort(),
  );
  assert.deepEqual(graph.nodes[0]?.bbox, {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  assert.deepEqual(
    graph.nodes.find((node) => node.id === "backing-1")?.bbox,
    { x: 0.08, y: 0.08, width: 0.24, height: 0.13 },
  );
});

test("strips one outer JSON fence and rejects nested or malformed JSON", async () => {
  const fixture = await readFixture();
  const content = fixture.choices[0]!.message.content;

  assert.equal(
    parseQwenSceneContent(`\`\`\`json\n${content}\n\`\`\``, {
      width: 1001,
      height: 701,
    }).nodes.length,
    7,
  );
  assert.throws(
    () =>
      parseQwenSceneContent(`\`\`\`json\n\`\`\`json\n${content}\n\`\`\`\n\`\`\``, {
        width: 1001,
        height: 701,
      }),
    /valid JSON/i,
  );
  assert.throws(
    () => parseQwenSceneContent('{"nodes":', { width: 1001, height: 701 }),
    /valid JSON/i,
  );
});

test("rejects dangling relation endpoints", async () => {
  const payload = parseFixturePayload(await readFixture());
  payload.relations[0]!.to = "missing-node";

  assert.throws(
    () =>
      parseQwenSceneContent(JSON.stringify(payload), {
        width: 1600,
        height: 900,
      }),
    /scene response/i,
  );
});

test("rejects provider coordinates outside normalized thousandths", async () => {
  const payload = parseFixturePayload(await readFixture());
  payload.nodes[1]!.bbox = [-1, 100, 300, 180];
  assert.throws(
    () =>
      parseQwenSceneContent(JSON.stringify(payload), {
        width: 1600,
        height: 900,
      }),
    /scene response/i,
  );

  payload.nodes[1]!.bbox = [100, 100, 1001, 180];
  assert.throws(
    () =>
      parseQwenSceneContent(JSON.stringify(payload), {
        width: 1600,
        height: 900,
      }),
    /scene response/i,
  );
});

test("rejects a provider background that does not cover the complete canvas", async () => {
  const payload = parseFixturePayload(await readFixture());
  payload.nodes[0]!.bbox = [0, 0, 500, 500];

  assert.throws(
    () =>
      parseQwenSceneContent(JSON.stringify(payload), {
        width: 1600,
        height: 900,
      }),
    /scene response/i,
  );
});

test("rejects duplicate node and relation IDs", async () => {
  const duplicateNode = parseFixturePayload(await readFixture());
  duplicateNode.nodes[1]!.id = duplicateNode.nodes[0]!.id;
  assert.throws(
    () =>
      parseQwenSceneContent(JSON.stringify(duplicateNode), {
        width: 1600,
        height: 900,
      }),
    /scene response/i,
  );

  const duplicateRelation = parseFixturePayload(await readFixture());
  duplicateRelation.relations[1]!.id = duplicateRelation.relations[0]!.id;
  assert.throws(
    () =>
      parseQwenSceneContent(JSON.stringify(duplicateRelation), {
        width: 1600,
        height: 900,
      }),
    /scene response/i,
  );
});

test("sends a generic JSON-only scene request for the owning canvas", async () => {
  const originalFetch = globalThis.fetch;
  const fixture = await readFixture();
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(
      completionWithContent(fixture.choices[0]!.message.content),
    );
  };

  try {
    const graph = await analyzeScene(
      Buffer.from([0x89, 0x50]),
      { width: 1377, height: 811 },
      config,
    );

    assert.equal(graph.nodes.length, 7);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      model: string;
      messages: Array<{ content: unknown }>;
    };
    assert.equal(body.model, config.visionModel);
    const serializedPrompt = JSON.stringify(body.messages[0]?.content);
    assert.match(serializedPrompt, /JSON only/i);
    assert.match(serializedPrompt, /1377 x 811/);
    assert.match(serializedPrompt, /background.*text-backing.*foreground-object/s);
    assert.match(serializedPrompt, /belongs-to.*connected-to.*carries-text/s);
    assert.match(serializedPrompt, /independently movable/i);
    assert.match(serializedPrompt, /compound/i);
    assert.match(serializedPrompt, /occlud/i);
    assert.match(serializedPrompt, /normalized thousandths/i);
    assert.match(serializedPrompt, /OCR is authoritative/i);
    assert.match(serializedPrompt, /labels? (?:are|is) audit-only/i);
    assert.match(serializedPrompt, /data:image\/png;base64,iVA=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("observes a content parse failure exactly once without request secrets", async () => {
  const originalFetch = globalThis.fetch;
  const image = Buffer.from("private-scene-image");
  const imageBase64 = image.toString("base64");
  const observed = createObserver();

  globalThis.fetch = async () =>
    Response.json(completionWithContent('{"nodes":'));

  try {
    await assert.rejects(
      analyzeScene(
        image,
        { width: 1440, height: 900 },
        config,
        observed.observer,
      ),
      /valid JSON/i,
    );
    assert.equal(observed.rawResponses.length, 1);
    assert.equal(observed.rawHttpResponses.length, 0);
    assert.equal(observed.parseErrors.length, 1);
    const serializedObservation = JSON.stringify({
      rawResponses: observed.rawResponses,
      rawHttpResponses: observed.rawHttpResponses,
      parseErrors: observed.parseErrors.map((error) => String(error)),
    });
    assert.doesNotMatch(serializedObservation, new RegExp(config.apiKey, "i"));
    assert.doesNotMatch(serializedObservation, new RegExp(imageBase64, "i"));
    assert.doesNotMatch(serializedObservation, /authorization/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("observes malformed HTTP JSON exactly once", async () => {
  const originalFetch = globalThis.fetch;
  const observed = createObserver();

  globalThis.fetch = async () =>
    new Response("not-provider-json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    await assert.rejects(
      analyzeScene(
        Buffer.from("private-scene-image"),
        { width: 1440, height: 900 },
        config,
        observed.observer,
      ),
      /HTTP response is not valid JSON/i,
    );
    assert.equal(observed.rawResponses.length, 0);
    assert.deepEqual(observed.rawHttpResponses, ["not-provider-json"]);
    assert.equal(observed.parseErrors.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an unvalidated compatible base before sending the image", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("must not be called");
  };

  try {
    await assert.rejects(
      analyzeScene(
        Buffer.from("private-scene-image"),
        { width: 1440, height: 900 },
        {
          ...config,
          dashscopeCompatibleBase:
            "https://workspace-123.cn-beijing.maas.aliyuncs.com.evil.example/compatible-mode/v1",
        },
      ),
      /safe Alibaba China compatible base URL/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new scene decision modules contain no acceptance-label or fixed-canvas branches", async () => {
  const modulePaths = [
    resolve("src/providers/qwen-scene.ts"),
    resolve("src/scene/plan.ts"),
  ].filter((path) => existsSync(path));
  assert.ok(modulePaths.length > 0, "expected a new scene decision module");

  for (const modulePath of modulePaths) {
    const sourceText = await readFile(modulePath, "utf8");
    assert.deepEqual(
      findSceneArchitectureViolations(sourceText, modulePath),
      [],
      `${modulePath} contains forbidden scene decisions`,
    );
  }
});

test("architecture guard ignores audit prose inside prompt-producing functions", () => {
  const promptSource = `
    function createScenePrompt(canvas: { width: number; height: number }) {
      const auditExample = canvas.width === 1280
        ? "\u773c\u775b slide-07 on 720"
        : "generic audit prose";
      return auditExample;
    }
  `;

  assert.deepEqual(findSceneArchitectureViolations(promptSource), []);
});

test("architecture guard catches equivalent executable decision branches", () => {
  const decisionSource = `
    function chooseLayer(node: { label: string }, canvas: { width: number }) {
      if (node.label === "\u773c\u775b" && canvas.width === 1280) return true;
      return false;
    }
  `;

  const violations = findSceneArchitectureViolations(decisionSource);
  assert.ok(violations.some((violation) => /audit-only label/.test(violation)));
  assert.ok(violations.some((violation) => /\u773c\u775b/.test(violation)));
  assert.ok(violations.some((violation) => /1280/.test(violation)));
});
