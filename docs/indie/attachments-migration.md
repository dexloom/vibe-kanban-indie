# Attachment Migration: Azure → Local Multipart

> **Audience:** the LLM agent merging this PR on the partner side (dexloom/vibe-kanban).
> This document describes what changed around attachments, why, and how to migrate
> an existing database / deployment. Read it in full before merging.

## 1. What changed

Issue/comment kanban attachments previously used an Azure Blob Storage flow that
called endpoints which **do not exist** in the local-only backend:

- `POST /v1/attachments/init`
- `POST /v1/attachments/confirm`
- `POST /v1/issues/{id}/attachments/commit`
- `POST /v1/comments/{id}/attachments/commit`
- `GET /v1/attachments/{id}/{type}` (SAS URL)

These were dead in the local build, so uploading a file in the issue panel or
comment panel silently failed. The migration moves issue/comment attachments onto
the same **multipart** path the workspaces already used:

- Upload: `POST /api/attachments/upload` (multipart field `image`) → `AttachmentResponse`.
- Serve: `GET /api/attachments/{id}/file`.
- Delete: `DELETE /api/attachments/{id}`.
- Link to owner: two new endpoints (below).

### New endpoints

| Method | Path | Body | Effect |
|---|---|---|---|
| `POST` | `/api/issues/{issueId}/attachments` | `{ "attachment_ids": ["uuid", ...] }` | Links attachments to an issue |
| `POST` | `/api/comments/{commentId}/attachments` | `{ "attachment_ids": ["uuid", ...] }` | Links attachments to a comment |

### Local issue comments

Issue comments previously had no local backend (the frontend's
`/v1/issue_comments` shape 404'd). This PR implements them end-to-end so
comment attachment linking has a working success path:

- Migration `20260802000002_add_issue_comments.sql` adds the `issue_comments`
  table (id, issue_id FK, parent_id, author_id, message, timestamps).
- Model `crates/db/src/models/issue_comment.rs` + `comment_attachments`
  junction now has a real FK target for future hardening.
- Routes in `local_kanban.rs`: `GET /v1/fallback/issue_comments?issue_id=...`,
  `POST /v1/issue_comments`, `PATCH /v1/issue_comments/{id}`,
  `DELETE /v1/issue_comments/{id}`. Comments use `LOCAL_USER_ID` as author.

### New database tables

Migration: `crates/db/migrations/20260802000001_add_issue_comment_attachments.sql`

- `issue_attachments` (junction: issue ↔ attachment)
- `comment_attachments` (junction: comment ↔ attachment)
- `DROP TABLE task_attachments` (dead table, no Rust usage)

Both junction tables follow the existing `workspace_attachments` pattern
(`id BLOB PRIMARY KEY, owner_id BLOB NOT NULL, attachment_id BLOB NOT NULL,
UNIQUE(owner_id, attachment_id)`).

Note: `comment_attachments.comment_id` intentionally has **no `REFERENCES`
clause**. Migration `…000001` runs before `…000002` (which creates the
`issue_comments` table), so an FK could not exist at junction-creation time.
An FK can be added in a later migration as hardening. Do not reorder these
migrations.

### Frontend

- Deleted: `useAzureAttachments.ts`, `useAttachmentUrl.ts`, `attachmentUtils.ts`
  (and the Azure helper functions in `remoteApi.ts`: `computeFileHash`,
  `uploadToAzure`, `initAttachmentUpload`, `confirmAttachmentUpload`,
  `commitIssueAttachments`, `commitCommentAttachments`, `fetchAttachmentSasUrl`,
  `sasUrlCache`).
- Added: `useIssueAttachments.ts` — multipart upload + per-file markdown insert,
  same public surface the panels already consumed (`uploadFiles`,
  `getAttachmentIds`, `clearAttachments`, `isUploading`, `uploadError`,
  `localAttachments`).
- `attachmentsApi` gained `linkIssueAttachments(issueId, ids)` and
  `linkCommentAttachments(commentId, ids)`.
- Markdown src for issue/comment attachments is now a same-origin absolute URL:
  `/api/attachments/{id}/file`. This renders in both editor and read-only views
  with **no** workspace/session context (unlike `.vibe-attachments/` paths,
  which require a workspace to resolve metadata).
- Lexical `image-node` / `attachment-node` dropped `attachment://` /
  `pending-attachment://` handling and now render `/api/attachments/...` srcs
  directly. `fetchAttachmentUrl`/`fetchAttachmentSasUrl` wiring removed from
  `WYSIWYGEditor.tsx`.
- Deleted dead `AttachmentWithBlob`, `InitUploadRequest`, `InitUploadResponse`,
  `ConfirmUploadRequest`, `CommitAttachmentsRequest`, `CommitAttachmentsResponse`,
  `AttachmentUrlResponse` from `shared/remote-types.ts` and
  `crates/api-types/src/{attachment.rs,blob.rs}`.

## 2. How existing data / DB should be migrated

The local build ships a **fresh** SQLite database (`db.v2.sqlite`) created by
running all migrations in order. If you are merging onto a deployment that
already ran the pre-migration schema:

1. **Run migrations** (they apply automatically on server start via
   `sqlx::migrate!`): `20260802000001_add_issue_comment_attachments.sql`
   creates the two junction tables and drops `task_attachments`;
   `20260802000002_add_issue_comments.sql` creates the `issue_comments` table.
2. **Existing data is preserved.** No destructive changes to `issues`,
   `attachments`, or `workspace_attachments`. Existing issues and their
   workspace attachments are untouched; the reaper (below) treats them exactly
   as before. No data backfill needed — the Azure upload flow never succeeded
   locally, so there is no legacy `attachment://` markdown to convert.
3. **Orphan reaper** (`File::find_orphaned_files`) now LEFT JOINs all three
   junction tables (`workspace_attachments`, `issue_attachments`,
   `comment_attachments`). A file is reaped at startup only if it is not linked
   by any of them. This preserves workspace attachments exactly as before and
   now also preserves issue/comment attachments.
4. **sqlx offline cache:** after touching migrations/models run
   `pnpm run prepare-db` from the repo root so the `.sqlx` cache matches the new
   queries (required before `cargo build`/CI `backend:check`).

## 3. Behavior after merge (verify manually)

- Issue panel edit mode: paste/drop an image → upload → inline `<img>` render →
  reload page → image still renders from `/api/attachments/{id}/file`.
- Issue panel edit mode, restart durability: edit an existing issue → attach an
  image → **restart the server** → reload → image must still render (the
  attachment is linked to the issue, so the orphan reaper must NOT delete it).
- Issue panel create mode: upload → submit → reopen created issue → image renders.
- Non-image file (e.g. PDF): renders as an attachment chip; click opens
  `/api/attachments/{id}/file` (forced download via Content-Disposition for
  non-image MIME types).
- Comment panel: same three flows.
- Workspace attachments are unaffected (they keep `.vibe-attachments/` srcs +
  workspace-context metadata resolution).

## 4. Known limitations / follow-ups

- **No upload progress bar.** Multipart upload is one-shot; the UI shows a
  boolean `isUploading` state. Progress reporting can be added later via XHR
  `upload.onprogress` in `attachmentsApi.upload` if desired.
- **No orphan reaping of removed references.** If a user uploads an attachment,
  submits, then edits the description to remove the `![...](...)` reference, the
  `issue_attachments` row persists and the file is not reaped. Disk growth is
  slow; a future pass can diff referenced ids on save and delete unreferenced
  files.
- **Compose-then-abandon leak.** Upload in create mode, then abandon without
  submitting → the file is reaped on next server start (no junction row exists).
  Acceptable for a single-dev local tool.
- **Startup race in the orphan reaper.** The orphan reaper runs once at
  startup as a fire-and-forget task; an upload that is linked after the
  reaper's query but before its delete completes could be lost. Probability
  is low.
- **Comment persistence failure swallows uploads.** If the comment insert
  (`persisted`) rejects, the typed text has already been cleared and any
  uploaded files are orphaned until the next restart.
