import { useEffect, useState } from 'react';
import {
  DEFAULT_THEME_VARIANT,
  type ThemeVariant,
  useThemeVariant,
} from '@/shared/stores/useUiPreferencesStore';

/**
 * Theme variants ("skins") are drop-in CSS files served from
 * `/themes/<id>.css`, listed in `/themes/index.json`. Each file scopes its
 * token overrides to `html[data-theme-variant="<id>"]`, so selecting a
 * variant is a matter of:
 *   1. setting `document.documentElement.dataset.themeVariant`, and
 *   2. ensuring the matching stylesheet is loaded.
 *
 * Variants are applied on top of the Light/Dark/System mode and are a purely
 * client-side preference (persisted to localStorage via the UI prefs store).
 */

export type ThemeManifestEntry = {
  id: string;
  name: string;
  description?: string;
};

type ThemeManifest = {
  themes: ThemeManifestEntry[];
};

const MANIFEST_URL = '/themes/index.json';
const themeHref = (id: string) => `/themes/${id}.css`;

const LINK_ID = 'vk-theme-variant';

/**
 * Inject (or remove) the variant stylesheet and reflect the active variant on
 * the <html> element. Idempotent and safe to call repeatedly.
 */
export function applyThemeVariant(variant: ThemeVariant): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const existing = document.getElementById(LINK_ID) as HTMLLinkElement | null;

  if (!variant || variant === DEFAULT_THEME_VARIANT) {
    delete root.dataset.themeVariant;
    existing?.remove();
    return;
  }

  root.dataset.themeVariant = variant;

  const href = themeHref(variant);
  if (existing) {
    if (!existing.href.endsWith(href)) existing.href = href;
  } else {
    const link = document.createElement('link');
    link.id = LINK_ID;
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
}

/**
 * Keep the DOM in sync with the selected theme variant. Call once near the
 * app root.
 */
export function useApplyThemeVariant(): void {
  const [variant] = useThemeVariant();
  useEffect(() => {
    applyThemeVariant(variant);
  }, [variant]);
}

let manifestCache: ThemeManifestEntry[] | null = null;

/**
 * Fetch the list of available theme variants from the manifest. Results are
 * cached for the session. Always resolves (returns [] on failure) so the
 * settings UI degrades gracefully.
 */
export async function fetchThemeManifest(): Promise<ThemeManifestEntry[]> {
  if (manifestCache) return manifestCache;
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = (await res.json()) as ThemeManifest;
    const themes = Array.isArray(data?.themes) ? data.themes : [];
    manifestCache = themes.filter((t) => t && typeof t.id === 'string');
    return manifestCache;
  } catch {
    return [];
  }
}

/**
 * Hook returning the available theme variants from the manifest (excluding the
 * implicit "default" entry, which callers should prepend as needed).
 */
export function useThemeManifest(): {
  themes: ThemeManifestEntry[];
  loading: boolean;
} {
  const [themes, setThemes] = useState<ThemeManifestEntry[]>(
    manifestCache ?? []
  );
  const [loading, setLoading] = useState(manifestCache === null);

  useEffect(() => {
    let cancelled = false;
    if (manifestCache) {
      setThemes(manifestCache);
      setLoading(false);
      return;
    }
    fetchThemeManifest().then((list) => {
      if (cancelled) return;
      setThemes(list);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { themes, loading };
}
