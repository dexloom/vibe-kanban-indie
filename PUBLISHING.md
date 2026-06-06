# Publishing `vibe-kanban-indie`

How releases work for this fork, and the exact steps for the **first** publish
(manual) and **every release after** (automated via GitHub Actions).

## How distribution works

`vibe-kanban-indie` is a tiny npm package (`npx-cli/`) — just `bin/cli.js`, no
binaries. At runtime the CLI downloads the prebuilt Rust binaries for the user's
platform from this repo's **GitHub Releases**:

```
https://github.com/dexloom/vibe-kanban-indie/releases/download/<tag>/<binary>-<platform>.zip
https://github.com/dexloom/vibe-kanban-indie/releases/download/<tag>/manifest.json   (sha256 + sizes)
```

Two invariants keep everything in lockstep (enforced by CI):

- **The git tag is `v<version>`** where `<version>` is `npx-cli/package.json`'s
  `version`. `npx-cli/src/download.ts` derives the download tag from that version
  (`BINARY_TAG = "v" + version`), so the npm package and its binaries always match.
- **The published npm tarball must NOT contain a `dist/` folder.** If `dist/`
  exists, `download.ts` flips into `LOCAL_DEV_MODE` and looks for bundled binaries
  instead of downloading them. So **never run `local-build.sh` in the publish
  step** — that's only for local development.

CI lives in [`.github/workflows/release-indie.yml`](.github/workflows/release-indie.yml):
on a `v*` tag it builds the web app, cross-compiles the 6 targets
(`linux/macos/windows` × `x64/arm64`), publishes a GitHub Release with the zips +
`manifest.json`, then `npm publish`es via **OIDC trusted publishing** (no token
stored). macOS binaries are unsigned — see [Notes](#notes).

---

## Prerequisites (one-time)

1. An npm account with publish rights.
2. `npm login` locally.
3. Confirm the name is free (first time only):
   ```bash
   npm view vibe-kanban-indie    # expect: 404 / "not found"
   ```

---

## Part 1 — First release (manual bootstrap)

npm **trusted publishing is configured on the package's settings page, so the
package must already exist** before you can enable it. That's the only reason the
first release is partly manual.

### 1. Tag the first version → CI builds the binaries

```bash
git checkout main
# Ensure npx-cli/package.json "version" is the version you want (e.g. 0.1.0).
git tag v0.1.0
git push origin v0.1.0
```

`release-indie.yml` runs. The **build** and **release** jobs create the GitHub
Release `v0.1.0` with all platform zips + `manifest.json`. The **`publish-npm`
job will fail** on this first run — that's expected, because the package doesn't
exist on npm yet and trusted publishing isn't configured. The binaries are what
matter here; ignore the red `publish-npm`.

### 2. Publish the npm package manually (creates it)

From a **clean checkout** (no `dist/`), publish the wrapper. Because the GitHub
Release from step 1 already exists, this version is immediately usable:

```bash
cd npx-cli
npm ci
npm run build          # esbuild → bin/cli.js (NOT local-build.sh)
# sanity check: the tarball must contain bin/ and NO dist/
npm pack --dry-run
npm publish --access public
```

> **2FA / access:** if your npm account enforces two-factor auth, `npm publish`
> returns `403 ... Two-factor authentication ... is required`. Add the current
> code: `npm publish --access public --otp=123456`, or use a **granular access
> token** (npmjs.com → Access Tokens) scoped to this package with publish rights
> and "bypass 2FA" enabled. This applies **only** to this one-time bootstrap —
> the automated releases in Part 2 authenticate via OIDC and never need a token
> or OTP.

Verify:
```bash
cd /tmp && npx vibe-kanban-indie@0.1.0   # downloads binaries from the release
```

### 3. Configure the trusted publisher (enables automation)

On npmjs.com → the **`vibe-kanban-indie`** package → **Settings → Trusted
Publisher → GitHub Actions**, enter:

| Field            | Value                     |
| ---------------- | ------------------------- |
| Organization/user| `dexloom`                 |
| Repository       | `vibe-kanban-indie`       |
| Workflow filename| `release-indie.yml`       |
| Environment      | *(leave blank)*           |

> If you later gate the `publish-npm` job behind a GitHub **Environment**, you
> must enter that same environment name here or OIDC will be rejected.

That's the bootstrap done — once.

---

## Part 2 — Every release after (fully automated)

No tokens, no manual `npm publish`. Just bump and tag:

```bash
git checkout main && git pull

# Bump the version in npx-cli/package.json (and keep it as the single source of
# truth for the tag). For example, 0.1.0 -> 0.1.1:
#   edit npx-cli/package.json  ->  "version": "0.1.1"
git commit -am "release: v0.1.1"
git push

# Verify the release passes the same gates as CI BEFORE tagging. The release
# workflow publishes on the tag without running tests, so this is your only
# guard against shipping a broken main (see Makefile `release-check`).
make release-check          # or: make release-check SKIP_TAURI=1

git tag v0.1.1
git push origin v0.1.1
```

> **Why the `make release-check` step matters.** `release-indie.yml` triggers on
> the tag and goes straight to build → publish — it does *not* run the `Test`
> workflow. The `Test` workflow runs separately on the `main` push, so nothing
> stops you from tagging a commit whose tests are red. `make release-check`
> mirrors every `Test` job locally; only push the tag once it's green.

Pushing the `v0.1.1` tag triggers `release-indie.yml`, which now runs end to end:
build → GitHub Release (binaries + manifest) → `npm publish` via OIDC (with
automatic build provenance). When it's green:

```bash
npx vibe-kanban-indie@latest
```

The `publish-npm` job has a guard that fails fast if the tag and
`npx-cli/package.json` version disagree, or if a `dist/` folder slipped in — so a
misconfigured release won't reach npm.

### Pre-release / test tags

Use a pre-release version to dry-run the whole pipeline without affecting
`@latest`:

```bash
# npx-cli/package.json -> "version": "0.1.1-rc.1"
git tag v0.1.1-rc.1 && git push origin v0.1.1-rc.1
npx vibe-kanban-indie@0.1.1-rc.1
```

---

## Notes

- **Unsigned macOS binaries.** They aren't notarized, so first launch may be
  blocked by Gatekeeper. Clear the quarantine attribute once:
  ```bash
  xattr -dr com.apple.quarantine ~/.vibe-kanban/bin
  ```
- **Linux is built static (musl).** If a future dependency fails to build on
  musl, switch the two `*-unknown-linux-musl` matrix targets to
  `*-unknown-linux-gnu` in `release-indie.yml`.
- **windows-arm64** cross-compilation can occasionally break on a dependency; if
  so, drop that entry from the matrix — the CLI errors cleanly on unsupported
  platforms.
- **Desktop (`--desktop`) is not published** for this fork (CLI binaries only);
  it falls back to browser mode on installed copies.
- The upstream `publish.yml` / `pre-release.yml` (Cloudflare R2 flow) are
  disabled (manual-only) and unused here.
