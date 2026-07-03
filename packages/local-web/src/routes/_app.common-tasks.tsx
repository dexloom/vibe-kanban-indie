import { createFileRoute } from '@tanstack/react-router';
import { CommonTasksPageContainer } from '@/pages/common-tasks/CommonTasksPage';

export const Route = createFileRoute('/_app/common-tasks')({
  component: CommonTasksPageContainer,
});
