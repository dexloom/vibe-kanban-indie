import { createContext, useContext } from 'react';

/**
 * Pure HSL colour math + phosphor-duotone machinery for sidebar project dots.
 *
 * Kept dependency-free (no React stores, no theme code) so it can live in the
 * low-level `ui` package. The active theme's duotone config is resolved in
 * `web-core` and injected through `ProjectColorTransformContext`; themes
 * without a duotone config get the identity transform (raw project colour).
 *
 * The duotone map: each project colour's perceptual *luminance* is normalised
 * across the reference palette's [min,max] range and mapped onto a
 * shadow→highlight ramp. Hue disappears; differentiation survives as
 * brightness steps — the way real phosphor/CRT monitors faked "colour".
 */

export type HslTriple = { h: number; s: number; l: number };

const HSL_RE = /^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*$/;

/** Parse a bare "H S% L%" triple (the format used by PRESET_COLORS). */
export function parseHsl(input: string): HslTriple | null {
  const m = HSL_RE.exec(input ?? '');
  if (!m) return null;
  return {
    h: Number(m[1]) % 360,
    s: Math.max(0, Math.min(100, Number(m[2]))),
    l: Math.max(0, Math.min(100, Number(m[3]))),
  };
}

/** Format a triple back to the bare "H S% L%" form (integer-rounded). */
export function formatHsl(c: HslTriple): string {
  return `${Math.round(c.h)} ${Math.round(c.s)}% ${Math.round(c.l)}%`;
}

function hslToRgb(c: HslTriple): { r: number; g: number; b: number } {
  const s = c.s / 100;
  const l = c.l / 100;
  const c1 = (1 - Math.abs(2 * l - 1)) * s;
  const hp = c.h / 60;
  const x = c1 * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c1, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c1, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c1, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c1];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c1];
  else if (hp < 6) [r1, g1, b1] = [c1, 0, x];
  const m1 = l - c1 / 2;
  return { r: r1 + m1, g: g1 + m1, b: b1 + m1 };
}

/** WCAG-style relative luminance in [0,1] for an HSL triple. */
export function relativeLuminance(c: HslTriple): number {
  const { r, g, b } = hslToRgb(c);
  const lin = (ch: number) =>
    ch <= 0.03928 ? ch / 12.92 : ((ch + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Interpolate between two HSL triples. Hue travels the shortest arc; s and l
 * are linear. Used to walk the shadow→highlight ramp.
 */
export function mixHsl(a: HslTriple, b: HslTriple, t: number): HslTriple {
  let dh = b.h - a.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return {
    h: (a.h + dh * t + 360) % 360,
    s: a.s + (b.s - a.s) * t,
    l: a.l + (b.l - a.l) * t,
  };
}

/** Maps a raw "H S% L%" project colour → a re-mapped "H S% L%" string. */
export type ProjectColorTransform = (rawColor: string) => string;

/** Pass-through transform: returns the raw colour unchanged. */
export const IDENTITY_TRANSFORM: ProjectColorTransform = (c) => c;

/**
 * Build a phosphor-duotone transform. Each input colour's luminance is
 * normalised against [minLum,maxLum] (the reference palette's range) and
 * mapped onto the shadow→highlight ramp. A mild gamma (0.9) lifts the
 * midtones so a cluster of medium-bright presets doesn't collapse to the
 * ramp's centre. Out-of-range luminance clamps to the ends.
 */
export function createDuotoneTransform(
  shadow: HslTriple,
  highlight: HslTriple,
  minLum: number,
  maxLum: number
): ProjectColorTransform {
  const span = maxLum - minLum || 1;
  return (rawColor: string) => {
    const c = parseHsl(rawColor);
    if (!c) return rawColor; // unparseable → pass through unchanged
    const lum = relativeLuminance(c);
    let t = (lum - minLum) / span;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    t = t ** 0.9;
    return formatHsl(mixHsl(shadow, highlight, t));
  };
}

/**
 * React context carrying the active theme's project-colour transform.
 * Default is identity (raw colours) so sidebar dots render normally when no
 * duotone theme is active or the provider is absent.
 */
export const ProjectColorTransformContext =
  createContext<ProjectColorTransform>(IDENTITY_TRANSFORM);

/** Read the active project-colour transform (identity if unprovided). */
export function useProjectColorTransform(): ProjectColorTransform {
  return useContext(ProjectColorTransformContext);
}
