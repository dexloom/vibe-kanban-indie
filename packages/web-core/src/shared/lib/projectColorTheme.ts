import { useEffect, useMemo } from 'react';
import { PRESET_COLORS } from '@/shared/lib/colors';
import {
  createDuotoneTransform,
  IDENTITY_TRANSFORM,
  parseHsl,
  relativeLuminance,
  type ProjectColorTransform,
} from '@vibe/ui/lib/projectColor';
import { useThemeVariant } from '@/shared/stores/useUiPreferencesStore';
import { useThemeManifest } from './themeVariant';

/**
 * Theme-aware sidebar project colour resolution.
 *
 * Reads the active theme variant + the manifest and produces:
 *   - `transform`: a phosphor-duotone map (or identity when the theme has no
 *     `projectColor` config / no theme is active), consumed by sidebar
 *     project dots via `ProjectColorTransformContext`.
 *   - `mainColor`: the theme's signature accent (bare HSL) for the
 *     orchestrator "prompt set" dot, applied to `:root` as `--vk-theme-main`
 *     so it falls back to `--brand` when unset.
 */

// The reference palette's luminance range is constant; compute once.
let presetLumRange: { min: number; max: number } | null = null;
function getPresetLumRange(): { min: number; max: number } {
  if (presetLumRange) return presetLumRange;
  let min = 1;
  let max = 0;
  for (const raw of PRESET_COLORS) {
    const c = parseHsl(raw);
    if (!c) continue;
    const lum = relativeLuminance(c);
    if (lum < min) min = lum;
    if (lum > max) max = lum;
  }
  presetLumRange = { min, max };
  return presetLumRange;
}

export type ThemedProjectColor = {
  transform: ProjectColorTransform;
  /** Bare HSL triple string ("H S% L%") for the orchestrator accent, or null. */
  mainColor: string | null;
};

/**
 * Resolve the active theme's project-colour transform + main accent. Also
 * mirrors `mainColor` onto `document.documentElement` as `--vk-theme-main`
 * (removed when the theme has no accent) so any CSS rule can opt in via
 * `hsl(var(--vk-theme-main, var(--brand)))`.
 */
export function useThemedProjectColor(): ThemedProjectColor {
  const [variant] = useThemeVariant();
  const { themes } = useThemeManifest();

  const resolved = useMemo(() => {
    const entry = variant ? themes.find((t) => t.id === variant) : undefined;
    const cfg = entry?.projectColor;
    if (!cfg) return { transform: IDENTITY_TRANSFORM, mainColor: null };

    const shadow = parseHsl(cfg.shadow);
    const highlight = parseHsl(cfg.highlight);
    const transform =
      shadow && highlight
        ? createDuotoneTransform(
            shadow,
            highlight,
            getPresetLumRange().min,
            getPresetLumRange().max
          )
        : IDENTITY_TRANSFORM;
    const mainColor = cfg.main ?? null;
    return { transform, mainColor };
  }, [variant, themes]);

  useEffect(() => {
    const root = document.documentElement;
    if (resolved.mainColor) {
      root.style.setProperty('--vk-theme-main', resolved.mainColor);
    } else {
      root.style.removeProperty('--vk-theme-main');
    }
  }, [resolved.mainColor]);

  return resolved;
}
