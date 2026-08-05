# TODO

## Рефактор: слить две шины данных в одну (инди-форк)

### Проблема

В локальном форке данных ходят по двум каналам с разной задержкой:

1. **Electric/fallback shape** (`useShape` → `createShapeCollection` → HTTP fallback poll раз в 30с) — сущности: issues, workspaces, связи issue↔workspace, PR, теги.
2. **WS-стрим** `/api/workspaces/streams/ws` — живой статус: `is_running`, процесс. Real-time.

Электрик в форке выкинут (локальный SQLite), а расщепление осталось от облачной архитектуры. Обе шины читают один SQLite, но задержки разные → класс багов «индикатор на не той карточке» (dispatch relink подъезжает через 30с, а `isRunning` — мгновенно). Текущий фикс — точечный `refreshShapeSource()` после мутаций.

### Задача

Убрать дублирование каналов: все данные из локального бэкенда гонять одним каналом (WS/SSE push) с немедленным обновлением коллекций `useShape`, либо перевести статусы на ту же шину, что и сущности.

### Подзадачи

- [ ] Спроектировать единый канал: WS/SSE на все shape-таблицы (или инкрементальный push поверх существующего WS-стрима).
- [ ] Убрать `FALLBACK_REFRESH_INTERVAL_MS` (30с поллинг) из `packages/web-core/src/shared/lib/electric/collections.ts` — заменяется push-обновлениями.
- [ ] Перевести `is_running`/статусы процессов на тот же канал (сейчас `/api/workspaces/streams/ws`, отдельная шина).
- [ ] `useShape`/`createShapeCollection` должны получать live-апдейты из единого канала (сейчас `applySnapshot` + интервал).
- [ ] Удалить `refreshShapeSource()` хаки — станут не нужны. Сейчас они висят в: `KanbanContainer` (dispatch), `IssueWorkspacesSectionContainer` (dispatch/unlink/delete), `useCreateWorkspace` (linkToIssue при create-and-start).
- [ ] Решить судьбу `useJsonPatchWsStream` и `/workspaces/streams/ws` после миграции.
- [ ] Проверить, что TUI и MCP не зависят от старой двухшинной модели.

### Примечания

- Для single-user локального форка conflict-resolution/op-log Electric не нужен — достаточно push-модели.
- Большой рефактор: проектный контекст (`ProjectProvider`, `UserProvider`, `useShape`) завязан на коллекции.
