import { createFileRoute } from '@tanstack/react-router';
import { OrchestratorPromptEditor } from '@/pages/projects/OrchestratorPromptEditor';

// ADR-016: full-pane editor for the per-project / per-board orchestrator
// prompt. The `_:orchestrator-prompt` suffix uses the same
// path-non-collision convention as the issues/workspaces routes so the
// bare `/projects/{id}` route still matches.
export const Route = createFileRoute(
  '/_app/projects/$projectId_/orchestrator-prompt'
)({
  component: OrchestratorPromptEditor,
});
