# Tasks: [FEATURE NAME]

**Plan**: `./plan.md`

Tasks are ordered by dependency. Tasks marked **[P]** touch independent files
and may run in parallel within their group. Each task names the file(s) it
changes.

## Phase 1: Setup
- [ ] T001 [P] Create module skeleton in `path/to/module`
- [ ] T002 [P] Add data structures in `path/to/types`

## Phase 2: Core
- [ ] T003 Implement core logic in `path/to/core` (depends on T001, T002)
- [ ] T004 Wire the entry point in `path/to/entry`

## Phase 3: Validation
- [ ] T005 [P] Add unit tests in `path/to/tests`
- [ ] T006 [P] Update documentation

<!--
Conventions:
- `T001` … task ids are stable and referenced by the dependency graph.
- `[P]` … parallel-safe (independent files). Omit for tasks that must be serial.
- `[ ]` / `[x]` … completion checkbox, toggled from the workbench.
-->
