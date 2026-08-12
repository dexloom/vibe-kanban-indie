import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_THEME_VARIANT,
  type ThemeVariant,
  useThemeVariant,
} from '@/shared/stores/useUiPreferencesStore';
import { useUserSystem } from '@/shared/hooks/useUserSystem';

/**
 * Theme variants ("skins") are drop-in CSS files served from
 * `/themes/<id>.css`, listed in `/themes/index.json`. Each file scopes its
 * token overrides to `html[data-theme-variant="<id>"]`, so selecting a
 * variant is a matter of:
 *   1. setting `document.documentElement.dataset.themeVariant`, and
 *   2. ensuring the matching stylesheet is loaded.
 *
 * Variants are applied on top of the Light/Dark/System mode. The
 * authoritative copy lives in the backend config (`config.theme_variant`)
 * so the preference survives across dev/npx/different-origin frontends;
 * localStorage is used as a fast client-side cache for the initial paint
 * (see `useSyncThemeVariantFromConfig`).
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

/**
 * Reconcile the client-side theme variant store with the backend config.
 * localStorage (the store's initial source) is per-origin, so it is empty on
 * the first visit from a different origin (dev vs npx vs another port).
 *
 * On first hydration we reconcile once:
 *   - If the backend has a real skin → adopt it (restores the preference
 *     across origins / fresh browsers).
 *   - Else if localStorage has a real skin → push it up to the config
 *     (one-time migration of a pre-existing client-only preference).
 *
 * After hydration the store is authoritative for the session; user changes
 * flow settings UI → store → config save, and the optimistic cache update in
 * `updateAndSaveConfig` keeps both sides aligned.
 */
export function useSyncThemeVariantFromConfig(): void {
  const { config, updateAndSaveConfig } = useUserSystem();
  const [variant, setVariant] = useThemeVariant();
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    const persisted = config?.theme_variant;
    if (!persisted) return; // config not loaded yet

    hydrated.current = true;

    const persistedIsReal = persisted !== DEFAULT_THEME_VARIANT;
    const localIsReal = variant !== DEFAULT_THEME_VARIANT;

    if (persistedIsReal) {
      if (persisted !== variant) setVariant(persisted);
    } else if (localIsReal) {
      updateAndSaveConfig({ theme_variant: variant });
    }
  }, [config?.theme_variant, variant, setVariant, updateAndSaveConfig]);
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
