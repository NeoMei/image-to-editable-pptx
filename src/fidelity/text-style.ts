import type { BBox } from "../contracts.js";

export type TextStyleMaskMetrics = {
  glyphBounds: BBox;
  inBoxForegroundCoverage: number;
  estimatedStrokeWidthPx: number;
};

export type EditableTextStyle = {
  fontSizePx: number;
  bold: boolean;
  charSpacingPx: number;
};

const CJK_OR_FULL_WIDTH_ADVANCE = 1;
const LATIN_UPPERCASE_ADVANCE = 0.62;
const LATIN_LOWERCASE_ADVANCE = 0.56;
const DIGIT_ADVANCE = 0.58;
const WHITESPACE_ADVANCE = 0.35;
const PUNCTUATION_ADVANCE = 0.4;
const OTHER_ADVANCE = 0.7;
const MEASURED_GLYPH_HEIGHT_TO_FONT_SIZE = 0.94;
const TEXT_LINE_HEIGHT_FACTOR = 1 / 0.94;
const TEXT_BOX_WIDTH_SAFETY = 0.96;
const MIN_ADVANCE_UNITS = 0.25;
const MIN_FONT_SIZE_PX = 0.1;
const MAX_FONT_SIZE_PX = 512;
const BOLD_GEOMETRY_SCORE_THRESHOLD = 0.12;
export const MAX_EDITABLE_TEXT_CHAR_SPACING_PX = 36;
const DISPLAY_TEXT_MIN_FONT_SIZE_PX = 48;
const DISPLAY_TEXT_ADVANCE_SCALE = 0.78;

function isCjkOrFullWidth(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x3400 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60)
  );
}

function characterAdvance(character: string): number {
  if (/\s/u.test(character)) return WHITESPACE_ADVANCE;
  if (isCjkOrFullWidth(character)) return CJK_OR_FULL_WIDTH_ADVANCE;
  if (/[A-Z]/u.test(character)) return LATIN_UPPERCASE_ADVANCE;
  if (/[a-z]/u.test(character)) return LATIN_LOWERCASE_ADVANCE;
  if (/\d/u.test(character)) return DIGIT_ADVANCE;
  if (/\p{P}/u.test(character)) return PUNCTUATION_ADVANCE;
  return OTHER_ADVANCE;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedTextLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function lineAdvanceUnits(line: string): number {
  return Array.from(line).reduce(
    (total, character) => total + characterAdvance(character),
    0,
  );
}

function visibleGapCount(line: string): number {
  const characters = Array.from(line);
  if (characters.filter((character) => !/\s/u.test(character)).length < 2) {
    return 0;
  }
  return Math.max(0, characters.length - 1);
}

export function inferEditableTextStyle(
  text: string,
  bbox: BBox,
  maskMetrics: TextStyleMaskMetrics,
): EditableTextStyle {
  const glyphHeight = finitePositive(maskMetrics.glyphBounds.height, 1);
  const boxHeight = finitePositive(bbox.height, MIN_FONT_SIZE_PX);
  const boxWidth = finitePositive(bbox.width, MIN_FONT_SIZE_PX);
  const lines = normalizedTextLines(text);
  const lineCount = Math.max(1, lines.length);
  const widestLineAdvanceUnits = Math.max(
    MIN_ADVANCE_UNITS,
    ...lines.map(lineAdvanceUnits),
  );
  const perLineGlyphHeight = glyphHeight / lineCount;
  const availableLineBoxHeight = boxHeight / lineCount;
  const measuredHeightBudget =
    perLineGlyphHeight * MEASURED_GLYPH_HEIGHT_TO_FONT_SIZE;
  const boxHeightBudget = availableLineBoxHeight / TEXT_LINE_HEIGHT_FACTOR;
  const boxWidthBudget =
    (boxWidth * TEXT_BOX_WIDTH_SAFETY) / widestLineAdvanceUnits;
  const fontSizePx = clamp(
    Math.round(
      Math.min(measuredHeightBudget, boxHeightBudget, boxWidthBudget) * 100,
    ) / 100,
    MIN_FONT_SIZE_PX,
    MAX_FONT_SIZE_PX,
  );

  const strokeWidth = finitePositive(maskMetrics.estimatedStrokeWidthPx, 0);
  const coverage = clamp(
    Number.isFinite(maskMetrics.inBoxForegroundCoverage)
      ? maskMetrics.inBoxForegroundCoverage
      : 0,
    0,
    1,
  );
  const normalizedStrokeWidth = strokeWidth / perLineGlyphHeight;
  const boldGeometryScore = normalizedStrokeWidth * (1 + coverage);
  const measuredSpan = Math.min(
    boxWidth,
    finitePositive(maskMetrics.glyphBounds.width, 0),
  );
  const feasibleTracking = lines.flatMap((line) => {
    const gaps = visibleGapCount(line);
    if (gaps === 0) return [];
    const advanceUnits = lineAdvanceUnits(line);
    const trackingAdvanceUnits =
      advanceUnits *
      (fontSizePx >= DISPLAY_TEXT_MIN_FONT_SIZE_PX
        ? DISPLAY_TEXT_ADVANCE_SCALE
        : 1);
    const targetSpan =
      measuredSpan * TEXT_BOX_WIDTH_SAFETY * (advanceUnits / widestLineAdvanceUnits);
    return [
      Math.max(0, (targetSpan - fontSizePx * trackingAdvanceUnits) / gaps),
    ];
  });
  const charSpacingPx = clamp(
    feasibleTracking.length === 0 ? 0 : Math.min(...feasibleTracking),
    0,
    MAX_EDITABLE_TEXT_CHAR_SPACING_PX,
  );

  return {
    fontSizePx,
    bold: boldGeometryScore >= BOLD_GEOMETRY_SCORE_THRESHOLD,
    charSpacingPx: Math.round(charSpacingPx * 100) / 100,
  };
}
