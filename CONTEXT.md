# CONTEXT — vibe-kanban-indie session dump (2026-08-05)

Резюме всей сессии для восстановления контекста на удалённой машине (mini).
Описание состояния репозитория, всех ADR, ревью-проходов, инцидента, текущего статуса
и НЕЗАКОНЧЕННОЙ работы.

## Репозиторий

- Path: `~/yt/vibe-kanban-indie` (на mini — `~/yt/vibe...`, уточнить точное имя)
- Branch: `feat/ui-modernization`
- Remote: `origin` = `git@github.com:vlat456/vibe-kanban-indie.git`; `dexloom` = `git@github.com:dexloom/vibe-kanban-indie.git`
- PR #11 open (dexloom/vibe-kanban-indie), head `feat/ui-modernization`
- Fork solo-dev (локальный kanban, no cloud/auth). Backend Rust (axum + sqlx + SQLite), frontend React/Vite (`packages/ui`, `packages/web-core`, `packages/local-web`).
- Layer rule: `packages/ui` NEVER imports web-core. `shared/types.ts` + `shared/remote-types.ts` — generated/hand-maintained wire contracts.

## Git состояние на момент дампа

- Закоммичено: `6e6824bf` (unified custom DnD), `00f6e626` (DnD polish + project reorder), `123cb0bd` (swap-model + snapshot), `2a5456c0` (positional cross-column move + swap fixes), `414625c4` (DnD hardening — 6 review passes, ui 219 / web-core 142).
- НЕ закоммичено (после `414625c4`): ADR-013 имплементация (project boards) + migration fix + все review-fixes work. Всё это — в рабочем дереве на момент дампа.
- `CONTEXT.md` (этот файл) — transient, НЕ коммитить.
- `CODE-OF-CONDUCT.md` заменён на "Don't be an asshole."

## ADR-012 — Unified custom drag-and-drop (завершён, 9.5/10)

- Файл: `docs/ADR/ADR-012-unified-custom-drag.md`
- Заменил hello-pangea на собственный pointer-based DnD (kanban board + sidebar tree).
- hello-pangea ОСТАЁТСЯ для: list view, sub-issues, settings status reorder (удаление — отдельный PR).
- 6 ревью-раундов (pass 1 → 7/10, pass 2 → 8.5, pass 3 → 9.0, pass 4 → 9.3, pass 5 → 9.4, pass 6 → 9.5 ✓).
- Архитектура: `packages/ui/src/components/dnd/DragController.ts` (state machine, Pointer Events, activePointerId, snapshots sourceCardRects/targetColumnRects, isPointerOverSource, sticky-restore, click-swallower, ESC), `geometry.ts`, `targetKind.ts`, `useDraggable.ts`, `KanbanBoard.tsx` (KanbanCard/KanbanCards), `sourceAttrs.ts` (SOURCE_DATA_ATTRS).
- web-core: `resolveDragEnd.ts` (классификатор), `persistIssues.ts` (persistIssues/persistIssueSwap/persistProjectReorder), `issueLookup.ts`, `KanbanContainer.tsx` (handleKanbanMove: swap/move/legacy, isManualSort, isSyncingCountRef + syncGuard), `SharedAppLayout.tsx` (dispatch).
- Interaction model: same-column card = SWAP (gated on sort_order); cross-column = MOVE с insertion index (manual sort) / append + status-only (non-manual); tree-status = move-issue.
- Тесты: ui 220, web-core 149 на момент ADR-013.
- Deferred (записано в ADR, TO RESOLVE): A2 (end-to-end integration test), A3 (snapshot lifecycle), KanbanContainer monolith split, dndPersisters extraction.

## ADR-013 — Project boards (имплементирован TDD, migration-fix внесён)

- Файл: `docs/ADR/ADR-013-project-boards.md`
- Решения (owner): board key `ACME-SUB-1` (parent key prefix chain + per-board issue_number), parent имеет свой kanban (kanban = attachable entity), можно ломать API/schema ради элегантности НО обязательны миграции.
- Синтез (escalate-glm + escalate-deepseek + review-glm): key separator `-` подтверждён (derive_key стрипает не-алфанум, `.` не нужен); NO key_path column (derive on demand); `ON DELETE RESTRICT`; DnD issue-move cross-project BLOCKED; project-reorder sibling-only; router UNCHANGED (leaf `/projects/:projectId`), breadcrumb в kanban header.
- Имплементация: `crates/db/migrations/20260805000001_add_project_parent_id.sql`, `Project.parent_id` + count_children/find_parent_chain_keys, `derive_key_chain` (walk parent_id, join `-`, cap 16), sibling_key_exists (400), delete_project 409 `{error:"project_has_children", children}`, recursive buildTreeData, DnD sibling filter, `swapProjectSiblings`, breadcrumb.
- Тесты после ADR-013: cargo 40 crates ok, ui 220, web-core 149.

## ⚠️ ИНЦИДЕНТ — каскадное удаление данных (важно для future safety)

- Исходная миграция использовала table-recreation (`DROP TABLE projects`). sqlx оборачивает миграции в транзакцию → `PRAGMA foreign_keys = OFF` внутри транзакции **no-op** → DROP TABLE при active FK выполняет неявный DELETE → каскад `ON DELETE CASCADE` снёс issues/project_statuses/project_repos/kanban_tags для одного пользователя. Воркспейсы осиротели (unassigned).
- ИСПРАВЛЕНО: миграция переписана на безопасный `ALTER TABLE ADD COLUMN parent_id BLOB REFERENCES projects(id) ON DELETE RESTRICT` (данные не трогаются, FK enforced). Проверено на чистой базе.
- Локальная база юзера: project_repos связь (repo rustlogic → project) восстановлена вручную; issues/statuses потеряны (юзер сказал не париться, мало данных; scratch содержит 3 заголовка).
- Локальный `_sqlx_migrations.checksum` для 20260805000001 обновлён вручную под новый файл. Сервер на порту 62253 работает (release build).
- **УРОК (записать в ADR)**: миграционный файл FROZEN — любая правка меняет SHA-384 checksum → VersionMismatch → macOS/Linux сервер не стартует. Не редактировать применённые миграции.

## ОБРАЗОВАЛСЯ review pass на ADR-013 (два ревью, НЕ починено — главный TODO на remote)

Два независимых critical-safety review (review-glm + review-deepseek) дали:
- glm: 7.5/10 — миграция SAFE (9.5), реализация нет. 3 ship-blocker: B-1 (wire contract drift — shared/remote-types.ts Project без parent_id, unsafe casts), B-2 (bySidebarProjectOrderAsc сортирует по UUID а не sort_order — DnD reorder сломан для подпроектов), B-3 (update_project silently ignores parent_id — reparent footgun).
- deepseek: 8.5/10 — миграция SAFE. 2 medium (persistProjectReorder rewrite-bombs ALL projects, resolveDragEnd нет parent_id guard), + HIGH (checksum trap), + minors.

### Полный список фиксов (задачи F-1..F-13) — НЕ ВЫПОЛНЕНЫ, надо запустить boring_work на mini:

- **F-1** SidebarProject.sortOrder + bySidebarProjectOrderAsc → sort по sort_order (BUG: reorder сломан). Files: `packages/ui/src/components/outliner/types.ts`, `buildTreeData.ts`, `SharedAppLayout.tsx` sidebarProjects memo.
- **F-2** Migration freeze warning → в ADR + CI-check `scripts/check-migration-frozen.sh` (`git diff --exit-code` на миграцию). НЕ редактировать сам .sql файл (checksum!).
- **F-3** Wire contract: добавить `parent_id` в `shared/remote-types.ts` Project/CreateProjectRequest/UpdateProjectRequest; убрать unsafe casts (`SharedAppLayout.tsx:466`, `buildProjectBreadcrumb.ts`, `projectOrder.ts`).
- **F-4** `update_project` + `bulk_projects` reject parent_id changes (BadRequest) — reparent deferred.
- **F-5** `delete_project_record` race → транзакция (count_children + delete в tx) или FK-violation → ConflictPayload. File: `crates/server/src/routes/local_kanban.rs:425`.
- **F-6** `ApiError::ConflictPayload` error_type не хардкодить "ProjectHasChildren" — выводить из payload["error"]. File: `crates/server/src/error.rs:358`.
- **F-7** `persistProjectReorder` scoped to sibling group (не rewrite-bomb все проекты). Files: `persistIssues.ts`, `SharedAppLayout.tsx` case 'project-reorder'.
- **F-8** SharedAppLayout: если swapProjectSiblings no-op (cross-parent) — не вызывать persistProjectReorder.
- **F-9** ADR-013 internal contradiction: Synthesis point 3 ложно ("ADD COLUMN не enforce FK" — на самом деле enforce; инцидент был про DROP+active FK). Поправить текст.
- **F-10** derive_key_chain N-query walk → лёгкий LRU cache (Mutex<HashMap<Uuid,(Instant,Vec<String>)>>, cap 128, TTL 60s). File: `local_kanban.rs`.
- **F-11** CREATE INDEX IF NOT EXISTS в миграции — НЕЛЬЗЯ (frozen). Просто note в ADR про recovery corrupted _sqlx_migrations.
- **F-12** useDraggable `[tabindex]` greediness — verify+document (grep tabindex в outliner/kanban).
- **F-13** bulk_projects unknown id silently dropped — warning log + comment (glm B-5).

Для F-фиксов: после них прогнать `cargo test -p db -p server`, `pnpm --filter @vibe/ui run test`, `pnpm --filter @vibe/web-core run test`, `pnpm run check`, `pnpm run generate-types:check`, `cargo fmt`, prettier. Тесты сейчас: cargo 40 crates ok, ui 220, web-core 149.

## Сервер / окружение

- Сервер: порт 62253, `VK_FRONTEND_DIR=$PWD/packages/local-web/dist`, бинарь `./target/release/server` (собран на локальной машине). На mini надо пересобрать (`cargo build --release -p server`) + frontend (`pnpm --filter @vibe/local-web run build`).
- База: `~/Library/Application Support/ai.bloop.vibe-kanban/db.v2.sqlite` (macOS). На mini путь может отличаться (ProjectDirs).
- Playwright smoke-скрипты в `/var/folders/.../T/opencode/` (dnd-swap-flake.js, dnd-hmove2.js, dnd-checkcols.js и т.д.) — временные, на mini не переносятся обязательно.

## OpenCode агенты / конфиг

- `~/.config/opencode/` — глобальный конфиг + AGENTS.md (caveman режим, делегирование boring_work/typewriter).
- `.agents/skills/` в репо (caveman, cavecrew, caveman-commit и др.).
- Агенты в opencode config (boring_work, typewriter, escalate-*, review-*, vk-*) — перекинуть на mini (см. шаг 4 юзера).

## Следующие шаги (план юзера)

0. Контекст в CONTEXT.md (этот файл) — done.
1. `git add .` (всё), 2. commit, 3. push (НЕ PR) на origin.
4. ssh mini (`ssh://vladimir@mini`), `~/yt/vibe...`, sync pushed branch, checkout `feat/ui-modernization`.
5. Перекинуть opencode-агентов + конфиг на mini.
6. На mini: запустить boring_work на F-1..F-13 (TODO выше).
