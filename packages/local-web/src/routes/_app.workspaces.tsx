import { createFileRoute } from '@tanstack/react-router';
import { WorkspacesDashboard } from '@/pages/workspaces/WorkspacesDashboard';

export const Route = createFileRoute('/_app/workspaces')({
  component: WorkspacesDashboard,
});
