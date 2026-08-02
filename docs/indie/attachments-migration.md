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

### New database tables

Migration: `crates/db/migrations/20260802000001_add_issue_comment_attachments.sql`

- `issue_attachments` (junction: issue ↔ attachment)
- `comment_attachments` (junction: comment ↔ attachment)
- `DROP TABLE task_attachments` (dead table, no Rust usage)

Both junction tables follow the existing `workspace_attachments` pattern
(`id BLOB PRIMARY KEY, owner_id BLOB NOT NULL, attachment_id BLOB NOT NULL,
UNIQUE(owner_id, attachment_id)`).

Note: `comment_attachments.comment_id` intentionally has **no `REFERENCES`
clause** — there is no `issue_comments` table in the local SQLite schema
(comments live behind the `/v1/issue_comments` shape/mutation surface, not a
direct table). Do not add an FK to a non-existent table; SQLite would reject
the migration.

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
   `sqlx::migrate!`): the `20260802000001_add_issue_comment_attachments.sql`
   migration creates the two junction tables and drops `task_attachments`.
2. **No data backfill needed.** No issue/comment attachments were ever
   successfully saved under the Azure flow (its endpoints 404'd), so there is no
   legacy `attachment://` markdown or orphaned Azure blob metadata to convert.
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
- **Comments caveat (pre-existing).** Issue comments render through the
  `/v1/issue_comments` shape surface; the local fallback route list in
  `local_kanban.rs` does not currently expose `/v1/fallback/issue_comments`.
  Comment attachment *linking* is wired end-to-end, but the comment section's
  data path is unchanged from before this PR — this migration does not regress it.
- **Startup race in the orphan reaper.** The orphan reaper runs once at
  startup as a fire-and-forget task; an upload that is linked after the
  reaper's query but before its delete completes could be lost. Probability
  is low.
- **Comment persistence failure swallows uploads.** If the comment insert
  (`persisted`) rejects in local mode, the typed text has already been
  cleared and any uploaded files are orphaned until the next restart
  (pre-existing comment data-path caveat).
