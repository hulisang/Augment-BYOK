"use strict";

function clampInt(n, { min = 0, max } = {}) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  const i = Math.floor(v);
  if (i < min) return min;
  if (Number.isFinite(Number(max)) && i > Number(max)) return Number(max);
  return i;
}

module.exports = { clampInt };

