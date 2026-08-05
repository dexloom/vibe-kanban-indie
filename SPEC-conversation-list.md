# SPEC: ConversationListContainer — react-virtuoso rewrite

**File**: `packages/web-core/src/features/workspace-chat/ui/ConversationListContainer.tsx`
**Date**: 2026-08-02

## Overview

Rewrite `ConversationListContainer.tsx` to use `react-virtuoso` (already a dependency). The current file is ~95% correct but has three critical bugs and one logic issue that must be fixed. No architectural redesign — only targeted fixes.

## Files to modify

### Primary file

- `packages/web-core/src/features/workspace-chat/ui/ConversationListContainer.tsx` — edit (not full rewrite)

### Parent files (NO changes needed)

All three consumers already have `key={...}` on `<ConversationList>`:

| File | Line | Key value |
|---|---|---|
| `packages/web-core/src/pages/workspaces/WorkspacesMainContainer.tsx` | 272 | `key={entriesProviderKey}` |
| `packages/web-core/src/pages/kanban/ProjectRightSidebarContainer.tsx` | 291 | `key={`${workspaceId}-${selectedSessionId ?? 'new'}`}` |
| `packages/web-core/src/pages/workspaces/VSCodeWorkspacePage.tsx` | 208 | `key={`${workspaceWithSession.id}-${selectedSessionId ?? 'new'}`}` |

## What stays (do not remove)

- `virtuosoRef`, `scrollContainerRef`, `currentRangeRef` — imperative handle needs them
- `rafIdRef`, `pendingUpdateRef` — rAF coalescing of streaming updates
- `scriptOutputCacheRef`, `prevEntriesRef`, `prevRowsRef` — incremental timeline builder, row-object reuse
- `flushPendingUpdate` + `onTimelineUpdated` — pre-render flush
- `useConversationHistory` with `scopeKey` — data fetching
- `useMemo` for `conversationRows` — stable reference for Virtuoso data
- `renderRowContent` function — pure dispatcher
- `Scroller` forwardRef component — custom scroller (hide scrollbar)
- `ApprovalFormProvider` wrapper
- Loading + empty overlays
- `Header` component (loading skeleton + setup placeholder)
- `Footer` component (cleanup placeholder + `pb-[50vh]`)
- `handleConfigureSetup`, `handleConfigureCleanup`
- `useResetProcess`, `useEntriesActions`, `useSetTokenUsageInfo`
- `ScriptFixerDialog`
- Plan-reveal `useLayoutEffect` (condition simplified, see below)
- `useImperativeHandle` and all handle methods (`scrollToPreviousUserMessage` body changed)

## What changes (exact edits)

### Change 1: Add `findPreviousUserMessageIndex` import

After line 16 (the `ConversationRow` import), update to:

```ts
import {
  type ConversationRow,
  findPreviousUserMessageIndex,
} from '../model/conversation-row-model';
```

### Change 2: Add `rangeChanged` callback to `<Virtuoso>`

In the `<Virtuoso>` JSX, add after `increaseViewportBy={400}`:

```tsx
rangeChanged={(range) => {
  currentRangeRef.current = range;
}}
```

Wires `currentRangeRef` to Virtuoso's `ListRange`. Every range change keeps it fresh.

### Change 3: Add `scrollerRef` callback to `<Virtuoso>`

In the `<Virtuoso>` JSX, add after `rangeChanged`:

```tsx
scrollerRef={(ref) => {
  scrollContainerRef.current = ref as HTMLDivElement | null;
}}
```

Wires `scrollContainerRef` to the actual scrollable DOM element. Cast needed because Virtuoso's `scrollerRef` type allows `Window`.

### Change 4: Replace `scrollToPreviousUserMessage` body

**Old code**:
```ts
const scrollToPreviousUserMessage = useCallback(() => {
  const range = currentRangeRef.current;
  if (!range || range.endIndex <= range.startIndex) return;
  const last = conversationRows[range.endIndex - 1];
  if (last && !last.isUserMessage) {
    virtuosoRef.current?.scrollToIndex({
      index: range.endIndex - 1,
      align: 'start',
      behavior: 'smooth',
    });
    return;
  }
  virtuosoRef.current?.scrollToIndex({
    index: range.startIndex,
    align: 'start',
    behavior: 'smooth',
  });
}, [conversationRows]);
```

**New code**:
```ts
const scrollToPreviousUserMessage = useCallback(() => {
  const startIndex = currentRangeRef.current.startIndex;
  const prevIdx = findPreviousUserMessageIndex(conversationRows, startIndex);
  if (prevIdx >= 0) {
    virtuosoRef.current?.scrollToIndex({
      index: prevIdx,
      align: 'start',
      behavior: 'smooth',
    });
  } else {
    virtuosoRef.current?.scrollToIndex({
      index: 0,
      align: 'start',
      behavior: 'smooth',
    });
  }
}, [conversationRows]);
```

Semantics: scans backwards from `startIndex - 1` (strictly above viewport), finds first user message, scrolls it to top with smooth animation. Falls back to index 0.

### Change 5: Simplify plan-reveal condition to use `rowFamily`

**Old code**:
```ts
useLayoutEffect(() => {
  const last = conversationRows[conversationRows.length - 1];
  if (!last) return;
  const et = last.entry;
  if (
    et.type === 'NORMALIZED_ENTRY' &&
    et.content.entry_type.type === 'tool_use' &&
    et.content.entry_type.action_type.action === 'plan_presentation'
  ) {
    virtuosoRef.current?.scrollToIndex({
      index: conversationRows.length - 1,
      align: 'start',
      behavior: 'auto',
    });
  }
}, [conversationRows.length]);
```

**New code**:
```ts
useLayoutEffect(() => {
  const last = conversationRows[conversationRows.length - 1];
  if (!last) return;
  if (last.rowFamily === 'plan') {
    virtuosoRef.current?.scrollToIndex({
      index: conversationRows.length - 1,
      align: 'start',
      behavior: 'auto',
    });
  }
}, [conversationRows.length]);
```

`rowFamily === 'plan'` is pre-computed by the row model — shorter, equivalent.

## Complete `<Virtuoso>` props checklist

| Prop | Value | Status |
|---|---|---|
| `ref` | `virtuosoRef` | Existing |
| `data` | `conversationRows` | Existing |
| `computeItemKey` | `(_index, row) => row.semanticKey` | Existing |
| `itemContent` | inline lambda | Existing |
| `followOutput` | `{(isAtBottom) => (isAtBottom ? 'auto' : false)}` | Existing |
| `atBottomStateChange` | `{onAtBottomChange}` | Existing |
| `initialTopMostItemIndex` | `{{ index: 'LAST', align: 'end' }}` | Existing |
| `increaseViewportBy` | `{400}` | Existing |
| `rangeChanged` | wires `currentRangeRef` | **ADD** |
| `scrollerRef` | wires `scrollContainerRef` | **ADD** |
| `components` | `{Scroller, Header, Footer}` | Existing |

## Complete imperative handle

| Method | Virtuoso call |
|---|---|
| `scrollToBottom(behavior)` | `scrollToIndex({ index: 'LAST', align: 'end', behavior })` |
| `scrollToPreviousUserMessage()` | `scrollToIndex({ index: prevIdx, align: 'start', behavior: 'smooth' })` via `findPreviousUserMessageIndex` |
| `adjustScrollBy(delta)` | `scrollBy({ top: delta })` (guard `< 0.5`) |
| `getScrollElement()` | Returns `scrollContainerRef.current` |
| `scrollToEntryByPatchKey(patchKey)` | `scrollToIndex({ index, align: 'start', behavior: 'auto' })` |
| `getVisibleUserMessagePatchKey()` | Scans backwards from `currentRangeRef.current.startIndex` |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `pb-[50vh]` dead scroll at bottom | Acceptable. Only visible when user scrolls past the last message; never seen in normal use. |
| Plan reveal during streaming jerks user from history | Plan is significant; jump is intentional. Add at-bottom gate later if user complains. |
| `scrollerRef` cast `as HTMLDivElement \| null` | Safe with custom `<Scroller>` div. |
| rAF in-flight on scope change | `useEffect` cleanup cancels it on unmount. No stale flush. |
| `findPreviousUserMessageIndex` returns -1 | Fallback: scroll to index 0. |
| `currentRangeRef` initial `{0,0}` before first `rangeChanged` | Harmless: `findPreviousUserMessageIndex(rows, 0)` → -1 → scrolls to 0. |

## Verification

```bash
pnpm run web-core:check
pnpm --filter @vibe/web-core run test
pnpm run local-web:check
```

Then build the frontend and verify in browser via the detached `VK_FRONTEND_DIR` setup. Test cases:

1. Open workspace at bottom → conversation loads, scrolled to bottom
2. Scroll up into history → no continuous jumps (Virtuoso handles heights; minor initial settle is one-time)
3. Scroll up, streaming arrives → `followOutput` is `false`, viewport stays put
4. Scroll to bottom, streaming arrives → `followOutput` `'auto'`, smooth follow
5. Plan appears → declarative `useLayoutEffect` scrolls plan to top via `pb-[50vh]` Footer room
6. Scroll-to-previous-user-message button → `findPreviousUserMessageIndex` finds user message above viewport, scrolls to it
7. Mouse wheel on non-scrollable area beside chat → `forwardWheelToScroller` gets the scroller via `scrollerRef`
8. Switch workspace/session → parent `key` changes → unmount → rAF canceled → remount fresh → `initialTopMostItemIndex` starts at bottom
9. Empty conversation → empty state overlay
10. Loading conversation → spinner overlay

## Implementation checklist

- [ ] Read current file
- [ ] Add `findPreviousUserMessageIndex` import
- [ ] Add `rangeChanged` prop
- [ ] Add `scrollerRef` prop
- [ ] Replace `scrollToPreviousUserMessage` body
- [ ] Simplify plan-reveal condition to `rowFamily === 'plan'`
- [ ] `pnpm run web-core:check` passes
- [ ] `pnpm --filter @vibe/web-core run test` passes
- [ ] `pnpm run local-web:check` passes
- [ ] Browser verification per test cases