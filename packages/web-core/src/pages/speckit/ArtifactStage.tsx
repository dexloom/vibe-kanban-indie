import { useEffect, useState } from 'react';
import { ArrowClockwiseIcon, ArrowSquareOutIcon } from '@phosphor-icons/react';
import type { SpecKitArtifact } from 'shared/types';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import { useTheme, getResolvedTheme } from '@/shared/hooks/useTheme';
import { specKitApi, ApiError } from '@/shared/lib/api';
import type { StageMeta } from './stages';

interface ArtifactStageProps {
  issueId: string;
  meta: StageMeta;
  /** The stage's main editable artifact, or null for stages with no single
   * canonical file (e.g. analyze). */
  primary: SpecKitArtifact | null;
  /** Read-only supporting artifacts (research/data-model/contracts). */
  supporting: SpecKitArtifact[];
  /** Live agent-session URL for the workspace driving this feature, if any. */
  liveHref: string | null;
  onRefresh: () => void;
}

export function ArtifactStage({
  issueId,
  meta,
  primary,
  supporting,
  liveHref,
  onRefresh,
}: ArtifactStageProps) {
  const { theme } = useTheme();
  const resolvedTheme = getResolvedTheme(theme);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the editor when the underlying artifact changes (e.g. after a run).
  useEffect(() => {
    setEditing(false);
    setDraft(primary?.content ?? '');
  }, [primary?.relative_path, primary?.content]);

  const handleSave = async () => {
    if (!primary) return;
    setSaving(true);
    setError(null);
    try {
      await specKitApi.putArtifact(issueId, {
        relative_path: primary.relative_path,
        content: draft,
      });
      setEditing(false);
      onRefresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save artifact.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-base overflow-y-auto p-double">
      <header className="space-y-half">
        <h2 className="text-lg font-semibold text-high">{meta.label}</h2>
        <p className="text-sm text-low">{meta.blurb}</p>
      </header>

      {/* Viewer controls */}
      <section className="flex items-center gap-base rounded-sm border p-base">
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-half rounded-sm border px-base py-half text-sm text-normal"
        >
          <ArrowClockwiseIcon className="size-icon-sm" />
          Refresh
        </button>
        {liveHref && (
          <a
            href={liveHref}
            className="inline-flex items-center gap-half text-sm text-brand underline"
            target="_blank"
            rel="noreferrer"
          >
            <ArrowSquareOutIcon className="size-icon-sm" />
            Open live workspace
          </a>
        )}
      </section>

      {error && <p className="text-sm text-error">{error}</p>}

      {/* Primary artifact */}
      {primary ? (
        <section className="flex min-h-48 flex-col gap-half rounded-sm border">
          <div className="flex items-center justify-between border-b px-base py-half">
            <span className="font-mono text-xs text-low">{primary.name}</span>
            {primary.exists &&
              (editing ? (
                <span className="flex gap-half">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleSave()}
                    className="rounded-sm bg-brand px-base py-px text-xs font-medium text-white disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setEditing(false);
                      setDraft(primary.content ?? '');
                    }}
                    className="rounded-sm border px-base py-px text-xs text-normal"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded-sm border px-base py-px text-xs text-normal"
                >
                  Edit
                </button>
              ))}
          </div>
          <div className="p-base">
            {!primary.exists ? (
              <p className="text-sm text-low">
                Not generated yet — the pipeline agent writes this artifact from
                the live workspace.
              </p>
            ) : editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="min-h-72 w-full rounded-sm border bg-panel/40 px-half py-half font-mono text-xs text-high"
              />
            ) : (
              <MarkdownPreview
                content={primary.content ?? ''}
                theme={resolvedTheme}
              />
            )}
          </div>
        </section>
      ) : (
        <p className="text-sm text-low">
          This stage's agent reports back in the live workspace — it doesn’t
          produce a stored file.
        </p>
      )}

      {/* Supporting artifacts (read-only) */}
      {supporting.filter((a) => a.exists).length > 0 && (
        <section className="space-y-half">
          <h3 className="text-sm font-medium text-high">
            Supporting artifacts
          </h3>
          {supporting
            .filter((a) => a.exists)
            .map((artifact) => (
              <details
                key={artifact.relative_path}
                className="rounded-sm border"
              >
                <summary className="cursor-pointer px-base py-half font-mono text-xs text-low">
                  {artifact.relative_path}
                </summary>
                <div className="border-t p-base">
                  {artifact.relative_path.endsWith('.json') ? (
                    <pre className="overflow-x-auto rounded-sm bg-panel/40 p-half font-mono text-xs text-high">
                      {artifact.content ?? ''}
                    </pre>
                  ) : (
                    <MarkdownPreview
                      content={artifact.content ?? ''}
                      theme={resolvedTheme}
                    />
                  )}
                </div>
              </details>
            ))}
        </section>
      )}
    </div>
  );
}
