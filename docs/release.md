# Release checklist

Releases go out from `main`. The owner publishes from their npm account with 2FA; CI never runs
`npm publish`, and a tag push only runs CI.

1. **On `main`, CI is green.** Wait for the `test` and `pack-install` jobs on all three OSes
   (Windows, macOS, Ubuntu).
2. **Run the open owner checks** in [`acceptance.md`](acceptance.md). Do not ship with a known
   failure that has no agreed carry-over.
3. **Bump the version** from a clean `main`:

   ```sh
   npm version patch   # or minor
   ```

   **First release only:** `package.json` already says `0.1.0`, so don't bump; tag it instead with
   `git tag v0.1.0`.

   This writes the commit and the `v*` tag.
4. **Push the commit and the tag:**

   ```sh
   git push --follow-tags
   ```

5. **Publish from the owner's account with 2FA:**

   ```sh
   npm publish --access public   # --access public is only needed the first time
   ```

6. **Create the GitHub release** from the tag, with notes taken from the merged slices.
7. **First release only:** switch the install block on the site to `npm i -g blockterm` and remove
   the "until then, build from source" line from the README "Install" section, then push to `main`
   (that push deploys the site).
8. **Verify the published package** on a clean machine: `npm i -g blockterm` (with
   `--allow-scripts=node-pty` on Linux, as the README says), then `blockterm --version` and
   `blockterm --help`.
