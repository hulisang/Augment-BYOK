"use strict";

function clampNonNegativeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const i = Math.floor(n);
  return i <= 0 ? 0 : i;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function utf32Length(s) {
  const str = typeof s === "string" ? s : "";
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (isHighSurrogate(code) && i + 1 < str.length && isLowSurrogate(str.charCodeAt(i + 1))) i += 1;
    count += 1;
  }
  return count;
}

function utf32ToUtf16Offset(s, utf32Offset) {
  const str = typeof s === "string" ? s : "";
  const target = clampNonNegativeInt(utf32Offset);
  if (!target) return 0;

  let count = 0;
  let i = 0;
  while (i < str.length && count < target) {
    const code = str.charCodeAt(i);
    if (isHighSurrogate(code) && i + 1 < str.length && isLowSurrogate(str.charCodeAt(i + 1))) i += 2;
    else i += 1;
    count += 1;
  }
  return i;
}

function utf16ToUtf32Offset(s, utf16Offset) {
  const str = typeof s === "string" ? s : "";
  const max = Math.min(str.length, clampNonNegativeInt(utf16Offset));
  if (!max) return 0;

  let count = 0;
  for (let i = 0; i < max; i++) {
    const code = str.charCodeAt(i);
    if (isHighSurrogate(code) && i + 1 < max && isLowSurrogate(str.charCodeAt(i + 1))) i += 1;
    count += 1;
  }
  return count;
}

function sliceUtf32(s, startUtf32, endUtf32) {
  const str = typeof s === "string" ? s : "";
  const a32 = clampNonNegativeInt(startUtf32);
  const b32 = Math.max(a32, clampNonNegativeInt(endUtf32));
  const a16 = utf32ToUtf16Offset(str, a32);
  const b16 = utf32ToUtf16Offset(str, b32);
  return str.slice(a16, b16);
}

module.exports = {
  clampNonNegativeInt,
  utf32Length,
  utf32ToUtf16Offset,
  utf16ToUtf32Offset,
  sliceUtf32
};

