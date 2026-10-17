# Releasing

Releases are published by the `Release` workflow
(`.github/workflows/release.yml`). Pushing a `v*` tag runs quality checks, tests
and the production build. It then publishes the package to npm and creates or
updates the GitHub release for that tag, with the CHANGELOG section as notes and
the `npm pack` tarball attached.

## Cut a release

1. Bump the version (no tag yet):

   ```sh
   npm version 0.1.1 --no-git-tag-version
   ```

2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [0.1.1] - YYYY-MM-DD` (or
   add that section) and summarise the changes. The workflow uses this section
   as the release notes and fails if it is missing.
3. Commit, open a PR, and merge it to `main` once CI passes.
4. Tag the merge commit and push the tag:

   ```sh
   git checkout main && git pull
   git tag -a v0.1.1 -m "v0.1.1"
   git push origin v0.1.1
   ```

The workflow fails early if the tag does not equal `v` + the `package.json`
version. If that version is already on npm, the publish step is skipped and only
the GitHub release is updated. Re-running the workflow is safe.

### Re-run for an existing tag

Use **Actions → Release → Run workflow** and enter the tag (for example
`v0.1.0`). The workflow checks out that tag and runs the same steps. Use this to
publish a version that was tagged before this workflow existed.

## npm authentication

The publish step supports two modes:

- **Trusted publishing (OIDC, preferred).** No secret is needed. The job has
  `permissions: id-token: write` and uses Node 24 with the latest npm (trusted
  publishing needs npm >= 11.5.1 and Node >= 22.14.0). Provenance is generated
  automatically for a public package published from a public repository;
  `--provenance` is also passed.
- **Token fallback.** If the repository secret `NPM_TOKEN` is set, it is used as
  `NODE_AUTH_TOKEN` instead. Use this for the first publish, because a trusted
  publisher can only be configured on a package that already exists on npm.

### First publish

1. On npmjs.com, create a granular access token with read and write access to
   publish packages for the `@com55` scope. It needs "bypass 2FA" if your
   account requires 2FA for writes, and a short expiry.
2. Add it to the GitHub repository as the Actions secret `NPM_TOKEN` (**Settings
   → Secrets and variables → Actions**).
3. Push the tag, or run the workflow manually with the existing tag.

### Switch to trusted publishing

After the package exists on npm:

1. Open npmjs.com → the package → **Settings → Trusted publishing**, and choose
   **GitHub Actions**.
2. Enter:
   - Organization or user: `com55`
   - Repository: `node-red-ai-access`
   - Workflow filename: `release.yml` (the filename only, with the extension)
   - Environment: leave empty
   - Allowed actions: enable direct `npm publish`. The workflow runs
     `npm publish`, not `npm stage publish`.
3. Complete a publish through the workflow within 2 days, or the new
   configuration expires and has to be recreated.
4. Delete the `NPM_TOKEN` secret and revoke the token on npmjs.com.
5. Optional: under the package's **Settings → Publishing access**, choose
   "Require two-factor authentication and disallow tokens". Trusted publishing
   keeps working.

`repository.url` in `package.json` must match this GitHub repository exactly, or
OIDC publishing is rejected.
