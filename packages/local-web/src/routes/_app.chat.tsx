import { createFileRoute } from '@tanstack/react-router';
import { ChatLanding } from '@/pages/workspaces/ChatLanding';

export const Route = createFileRoute('/_app/chat')({
  component: ChatLanding,
});
