import { createFileRoute } from '@tanstack/react-router';
import { SpecKitWorkbench } from '@/pages/speckit/SpecKitWorkbench';
import { projectSearchValidator } from '@vibe/web-core/project-search';

export const Route = createFileRoute(
  '/_app/projects/$projectId_/speckit/$featureId'
)({
  validateSearch: projectSearchValidator,
  component: SpecKitWorkbench,
});
