import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const directory = dirname(fileURLToPath(import.meta.url));

function svg(width, height, content, background = "#f5f0e6") {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${background}"/>${content}</svg>`,
  );
}

function checkerboard(width, height) {
  const cells = [];
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const index = (x / 8 + y / 8) % 2;
      cells.push(`<rect x="${x}" y="${y}" width="8" height="8" fill="${index === 0 ? "#233447" : "#ef6a32"}"/>`);
    }
  }
  return cells.join("");
}

const fixtures = [
  {
    name: "canvas-16x9.png",
    purpose: "16:9 PNG canvas contract and transform coverage.",
    bytes: () => sharp(svg(320, 180, '<circle cx="82" cy="90" r="34" fill="#3478b8"/><rect x="140" y="62" width="118" height="56" rx="12" fill="#f08a32"/>')).png().toBuffer(),
  },
  {
    name: "canvas-4x3.jpg",
    purpose: "4:3 JPEG decode and compression-ringing coverage.",
    bytes: () => sharp(svg(320, 240, '<path d="M45 190 L130 45 L215 190 Z" fill="#377fae"/><circle cx="235" cy="92" r="42" fill="#e97238"/>', "#f8f5ed")).jpeg({ quality: 82, chromaSubsampling: "4:2:0" }).toBuffer(),
  },
  {
    name: "canvas-portrait.png",
    purpose: "Portrait canvas transform and bounded-layout coverage.",
    bytes: () => sharp(svg(180, 320, '<rect x="28" y="42" width="124" height="72" rx="14" fill="#2d6f9f"/><rect x="28" y="138" width="124" height="140" rx="18" fill="#e5a13c"/>')).png().toBuffer(),
  },
  {
    name: "canvas-square.png",
    purpose: "Square canvas transform and scaling coverage.",
    bytes: () => sharp(svg(256, 256, '<circle cx="128" cy="128" r="84" fill="#3376a8"/><circle cx="128" cy="128" r="42" fill="#f2c260"/>')).png().toBuffer(),
  },
  {
    name: "canvas-ultrawide.png",
    purpose: "Ultrawide bounded-layout and aspect-ratio coverage.",
    bytes: () => sharp(svg(560, 80, '<rect x="20" y="18" width="145" height="44" rx="10" fill="#3478b8"/><rect x="206" y="18" width="145" height="44" rx="10" fill="#e67636"/><rect x="392" y="18" width="145" height="44" rx="10" fill="#5a9c68"/>')).png().toBuffer(),
  },
  {
    name: "text-backing.png",
    purpose: "Editable text backing extraction without embedded fonts.",
    bytes: () => sharp(svg(320, 180, '<rect x="48" y="56" width="224" height="68" rx="18" fill="#235d8e"/><g fill="#ffffff"><rect x="78" y="77" width="18" height="26"/><rect x="108" y="77" width="18" height="26"/><rect x="138" y="77" width="72" height="8"/><rect x="138" y="95" width="48" height="8"/></g>')).png().toBuffer(),
  },
  {
    name: "connected-composition.png",
    purpose: "Connected compound grouping and shared-mask coverage.",
    bytes: () => sharp(svg(320, 180, '<circle cx="112" cy="90" r="42" fill="#3b82b4"/><rect x="112" y="72" width="98" height="36" rx="18" fill="#3b82b4"/><circle cx="218" cy="90" r="30" fill="#f0a03b"/>')).png().toBuffer(),
  },
  {
    name: "occlusion.png",
    purpose: "Occlusion ordering and hidden-region review coverage.",
    bytes: () => sharp(svg(320, 180, '<circle cx="132" cy="90" r="58" fill="#397aae"/><rect x="146" y="38" width="88" height="104" rx="18" fill="#ed7537"/>')).png().toBuffer(),
  },
  {
    name: "must-fallback.png",
    purpose: "Dense crossing texture that must remain in the background.",
    bytes: () => sharp(svg(320, 180, checkerboard(320, 180), "#ffffff")).png().toBuffer(),
  },
];

await mkdir(directory, { recursive: true });
const provenance = {
  generatedBy: "generate.mjs",
  license: "CC0-1.0",
  note: "Deterministic geometric fixtures generated in-repository; no third-party slide artwork.",
  files: {},
};

for (const fixture of fixtures) {
  const bytes = await fixture.bytes();
  await writeFile(join(directory, fixture.name), bytes);
  provenance.files[fixture.name] = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    purpose: fixture.purpose,
  };
}

await writeFile(
  join(directory, "provenance.json"),
  `${JSON.stringify(provenance, null, 2)}\n`,
  { mode: 0o600 },
);
