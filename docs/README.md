# Vibe Kanban Indie — Documentation

The documentation site for [Vibe Kanban Indie](https://github.com/dexloom/vibe-kanban-indie),
built with [Mintlify](https://mintlify.com). Source lives in this `docs/` folder;
`docs.json` defines navigation, theme, and settings.

## Develop locally

Install the Mintlify CLI:

```bash
npm i -g mint
```

Run the preview server from this `docs/` directory (where `docs.json` lives):

```bash
mint dev
```

The preview is served at `http://localhost:3000`.

Check for broken internal links before pushing:

```bash
mint broken-links
```

## Writing guidelines

See [`AGENTS.md`](AGENTS.md) for the Mintlify component reference and the project's
technical-writing conventions (British English, frontmatter on every page, second
person, Mintlify components such as `<Steps>`, `<Card>`, and `<Note>`).

Every `.mdx` page must start with YAML frontmatter:

```yaml
---
title: "Clear, specific, keyword-rich title"
description: "Concise summary for SEO and navigation"
---
```

## Publishing

Changes merged to `main` that touch `docs/` are deployed automatically by the
Mintlify GitHub App. See the repository's `PUBLISHING.md` for the one-time setup
(installing the GitHub App and pointing it at this `docs/` directory).

## Troubleshooting

- **Dev server won't start**: run `mint update` to get the latest CLI.
- **A page loads as 404**: ensure you're running `mint dev` from a folder
  containing a valid `docs.json`, and that the page is listed in `docs.json`
  navigation.
