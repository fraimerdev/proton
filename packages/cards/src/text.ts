const RENDERABLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: these are code points, not grapheme clusters. The combining marks (U+0304, U+0308, U+0329) are members of the font's subset in their own right and are meant to match individually.
  /[ -ÿıŒ-œʻ-ʼˆ˚˜̩̄̈ -⁯€™↑↓−∕﻿�]/u;

const UNRENDERABLE_NAME = 'Member';

export function sanitiseText(input: string, fallback = UNRENDERABLE_NAME): string {
  const kept = [...input].filter((char) => RENDERABLE.test(char)).join('');

  const collapsed = kept.replace(/\s+/gu, ' ').trim();
  return collapsed.length > 0 ? collapsed : fallback;
}

export function monogram(displayName: string): string {
  const first = [...sanitiseText(displayName, '')].find((char) => /[\p{L}\p{N}]/u.test(char));
  return (first ?? '?').toUpperCase();
}

export function group(value: number): string {
  return value.toLocaleString('en-US');
}

const UNITS = [
  { at: 1_000_000_000, suffix: 'b' },
  { at: 1_000_000, suffix: 'm' },
  { at: 1_000, suffix: 'k' },
];

export function abbreviate(value: number): string {
  for (const { at, suffix } of UNITS) {
    if (value < at) continue;

    const scaled = value / at;
    // 1.2k, but 12k rather than 12.0k — a decimal that reads as noise at two significant figures.
    return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.floor(scaled)}${suffix}`;
  }

  return String(value);
}
