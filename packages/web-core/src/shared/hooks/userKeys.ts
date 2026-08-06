// ADR-018 — tenant-less user-list query keys. Replaces `organizationKeys`
// (which encoded an orgId); the new `/v1/users` endpoint returns all
// users regardless of org, so a single key is sufficient.
export const userKeys = {
  all: ['users'] as const,
  list: () => ['users', 'list'] as const,
};
