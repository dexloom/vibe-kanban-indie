import { useEffect, useState } from 'react';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { MarkdownPreview } from '@/shared/components/MarkdownPreview';
import { useTheme, getResolvedTheme } from '@/shared/hooks/useTheme';
import { specKitApi, ApiError } from '@/shared/lib/api';

interface ConstitutionStageProps {
  issueId: string;
  liveHref: string | null;
}

/**
 * Project-wide constitution editor. Scoped to the workspace's agent-cwd base
 * (`.specify/memory/constitution.md`); commit it to the base branch so every
 * feature inherits it.
 */
export function ConstitutionStage({
  issueId,
  liveHref,
}: ConstitutionStageProps) {
  const { theme } = useTheme();
  const resolvedTheme = getResolvedTheme(theme);
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await specKitApi.getConstitution(issueId);
      setContent(res.content);
      setDraft(res.content);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Failed to load constitution.'
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await specKitApi.putConstitution(issueId, {
        content: draft,
        exists: true,
      });
      setContent(res.content);
      setEditing(false);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Failed to save constitution.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-base overflow-y-auto p-double">
      <header className="space-y-half">
        <h2 className="text-lg font-semibold text-high">Constitution</h2>
        <p className="text-sm text-low">
          Project principles every feature must honor. The Specify, Plan, and
          Analyze stages check work against this.
        </p>
      </header>

      {liveHref && (
        <section className="rounded-sm border p-base">
          <a
            href={liveHref}
            className="inline-flex items-center gap-half text-sm text-brand underline"
            target="_blank"
            rel="noreferrer"
          >
            <ArrowSquareOutIcon className="size-icon-sm" />
            Open live workspace
          </a>
        </section>
      )}

      {error && <p className="text-sm text-error">{error}</p>}

      <section className="flex min-h-48 flex-col gap-half rounded-sm border">
        <div className="flex items-center justify-between border-b px-base py-half">
          <span className="font-mono text-xs text-low">
            .specify/memory/constitution.md
          </span>
          {!loading &&
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
                    setDraft(content);
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
          {loading ? (
            <p className="text-sm text-low">Loading…</p>
          ) : editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-72 w-full rounded-sm border bg-panel/40 px-half py-half font-mono text-xs text-high"
            />
          ) : content ? (
            <MarkdownPreview content={content} theme={resolvedTheme} />
          ) : (
            <p className="text-sm text-low">
              No constitution yet — run{' '}
              <span className="font-mono">/speckit.constitution</span> in the
              live workspace, or edit directly.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
