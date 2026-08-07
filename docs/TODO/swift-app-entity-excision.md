# Swift macOS app — entity-excision follow-up

**Status**: OPEN (deferred from ADR-018 + ADR-019 by owner decision 2026-08-05).
**Owner decision**: the Swift app is intentionally left for a tracked follow-up;
its decode will fail until edited.

## Why this exists

ADR-018 (org excision) and ADR-019 (user excision) removed wire fields + endpoints
that the in-repo macOS Swift app (`apps/macos/`, 97 files) still decodes/encodes.
The ADRs initially claimed the Swift app was "out-of-repo" — that was FALSE; the
app is committed in this repo. The claim was amended; the Swift edit is deferred
here.

## What breaks (verified 2026-08-05)

`apps/macos/Sources/VibeKanbanMac/`:

- `Models/Project.swift:18` — `organizationId` (non-optional `let`) decodes `organization_id` (REMOVED by ADR-018) → `keyNotFound` on every project decode.
- `Models/WorkspaceSummary.swift:24` — `ownerUserId` (non-optional `let`) decodes `owner_user_id` (REMOVED by ADR-019) → decode failure.
- `Models/SettingsRequests.swift:18,130` — encodes `organization_id` (dead field, harmless but stale).
- `Models/Tag.swift:31,117` — `IssueAssignee` + `IssueAssigneesResponse` decode the removed shape.
- `Networking/APIClient.swift:137-140` — `listIssueAssignees()` calls `/v1/fallback/issue_assignees` (route REMOVED) → 404.
- `Features/Board/BoardViewModel.swift:30,62,67,123-124` — drives assignee UI from the 404'd endpoint.
- `Features/Board/KanbanColumnView.swift:24`, `KanbanCardView.swift:7,17,67-68`, `Features/IssueDetail/IssueDetailView.swift:99-102`, `Components/AvatarStack.swift` — assignee avatar UI.
- `Features/Notifications/NotificationsView.swift` + `Features/Sidebar/ProjectSidebarView.swift:33-41` — notifications UI for the removed entity.

## What to do

Apply the same excision to `apps/macos/`:
1. Drop `organizationId` from `Project`, `Notification` (if present), `CreateProjectRequest`, `ExportRequest`; drop `OrganizationMember`/`MemberRole` (ADR-018).
2. Drop `ownerUserId` from `WorkspaceSummary`; drop `IssueAssignee`, `IssueAssigneesResponse`, `listIssueAssignees`, the assignee avatar UI (Board/IssueDetail/KanbanCard/AvatarStack); drop notifications UI (ADR-019).
3. Update `Tests/` (`SettingsModelTests.swift:57`, `EntityDecodingTests.swift:40`, `ModelDecodingTests.swift:12`) to drop the removed fields from fixtures.
4. `xcodebuild test -scheme VibeKanbanMac` against a post-migration backend → must pass.

## Files to touch (exhaustive from the 2026-08-05 grep)

```
apps/macos/Sources/VibeKanbanMac/Models/Project.swift
apps/macos/Sources/VibeKanbanMac/Models/WorkspaceSummary.swift
apps/macos/Sources/VibeKanbanMac/Models/SettingsRequests.swift
apps/macos/Sources/VibeKanbanMac/Models/Tag.swift
apps/macos/Sources/VibeKanbanMac/Networking/APIClient.swift
apps/macos/Sources/VibeKanbanMac/Features/Board/BoardViewModel.swift
apps/macos/Sources/VibeKanbanMac/Features/Board/KanbanColumnView.swift
apps/macos/Sources/VibeKanbanMac/Features/Board/KanbanCardView.swift
apps/macos/Sources/VibeKanbanMac/Features/IssueDetail/IssueDetailView.swift
apps/macos/Sources/VibeKanbanMac/Components/AvatarStack.swift
apps/macos/Sources/VibeKanbanMac/Features/Notifications/NotificationsView.swift
apps/macos/Sources/VibeKanbanMac/Features/Sidebar/ProjectSidebarView.swift
apps/macos/Tests/VibeKanbanMacTests/SettingsModelTests.swift
apps/macos/Tests/VibeKanbanMacTests/EntityDecodingTests.swift
apps/macos/Tests/VibeKanbanMacTests/ModelDecodingTests.swift
```
