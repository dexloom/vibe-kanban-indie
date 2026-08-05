/**
 * Parse a comma-separated list of allowed origin URLs from the Settings UI.
 *
 * Each entry must be a valid http(s) URL. Whitespace is trimmed; empty
 * entries are dropped. Returns the parsed values (preserving order) and
 * an error message describing the first invalid entry, or null on success.
 */
export function parseAllowedOriginsCsv(csv: string): {
  values: string[];
  error: string | null;
} {
  const entries = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return { values: [], error: `Invalid URL: ${entry}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { values: [], error: `Must be http or https: ${entry}` };
    }
    // Origins are scheme+host+port only — a path/query/hash never appears in a
    // browser Origin header and would be silently dropped by the backend
    // parser, so reject it here for symmetry.
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return { values: [], error: `Origin must not include a path: ${entry}` };
    }
  }
  return { values: entries, error: null };
}
