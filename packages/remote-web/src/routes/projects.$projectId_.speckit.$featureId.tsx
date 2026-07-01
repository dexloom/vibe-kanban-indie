import { createFileRoute } from "@tanstack/react-router";
import { requireAuthenticated } from "@remote/shared/lib/route-auth";
import { SpecKitWorkbench } from "@/pages/speckit/SpecKitWorkbench";
import { projectSearchValidator } from "@vibe/web-core/project-search";

export const Route = createFileRoute(
  "/projects/$projectId_/speckit/$featureId",
)({
  beforeLoad: async ({ location }) => {
    await requireAuthenticated(location);
  },
  validateSearch: projectSearchValidator,
  component: SpecKitWorkbench,
});
