---
name: release
description: Release pi-compact-tui through its GitHub release process. Use when the user asks to publish a version, bump and tag a release, or create a GitHub Release for this repository.
---

# Release

A release is a **checkpointed state machine**. Before each mutation, inspect whether that checkpoint already exists. Resume from the first incomplete checkpoint; when an existing artifact disagrees with the requested version or commit, stop and report the conflict.

## 1. Establish the release contract

1. Read the target version from the request; ask for it when absent. Normalize it as `X.Y.Z` for `package.json` and `vX.Y.Z` for Git/GitHub.
2. Refresh remote refs with `git fetch origin master --tags`, then inspect:
   - `git status --short --branch`
   - current `package.json` version
   - local and remote tags
   - commits since the latest release tag
   - the previous release commit and `gh release view <latest-tag>`
3. Confirm all of the following:
   - the target is valid SemVer and greater than the current version on a new run; equality is valid only when the existing release commit is verified during resume;
   - a new release starts from `master`, synchronized with `origin/master`; during resume, any local lead is exactly the verified release commit;
   - the target tag and GitHub Release are absent, or already point to the exact release commit during a resumed run;
   - every dirty path is classified as release-related or pre-existing unrelated work.

Keep product changes in their own commits. Preserve pre-existing unrelated files exactly as found and exclude them from staging.

**Completion criterion:** the target version, previous tag, release commit range, dirty-path classification, and state of every target artifact are known.

## 2. Prepare the release candidate

1. Change only `package.json` from the current version to `X.Y.Z`.
2. Run the project release checks:

   ```bash
   pnpm typecheck
   pnpm test
   ```

3. Inspect the diff and staged state. The release diff must contain only the intended version change in `package.json`.
4. Draft English release notes from `<previous-tag>..HEAD`, excluding the release commit:
   - start with `## What's Changed`;
   - group user-visible changes by extension;
   - describe behavior and configuration rather than commit mechanics;
   - end with `**Full Changelog:** https://github.com/saltfishpr/pi-compact-tui/compare/<previous-tag>...vX.Y.Z`.

A failed check is a hard stop before commit or tag creation.

**Completion criterion:** `package.json` contains the target version, both checks pass, the diff is release-only, and every non-release commit since the previous tag is represented in the notes.

## 3. Create the local release checkpoint

1. Stage only `package.json`.
2. Create the release commit:

   ```bash
   git commit -m "chore: release vX.Y.Z"
   ```

3. Create the lightweight tag used by this repository:

   ```bash
   git tag vX.Y.Z
   ```

4. Verify the commit message, version, and tag target. The tag must resolve to the release commit at `HEAD`.

For resumed runs, skip a commit or tag only after verifying it is identical to the expected checkpoint.

**Completion criterion:** the local release commit contains only the version bump, and `vX.Y.Z^{commit}` resolves to that commit.

## 4. Publish and verify

1. Run `git` and `gh` directly with no per-command proxy variables; preserve the user's persistent Git configuration.
2. Push the branch, then the tag:

   ```bash
   git push origin master
   git push origin vX.Y.Z
   ```

3. Create the GitHub Release from the prepared notes, matching the previous release's title and Markdown structure:

   ```bash
   gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes-file <notes-file>
   ```

4. Verify independently:
   - `origin/master` contains the release commit;
   - remote tag `vX.Y.Z` resolves to the same commit;
   - `gh release view vX.Y.Z` reports a published, non-prerelease release;
   - `git status --short --branch` contains only the pre-existing unrelated paths.

This repository publishes through GitHub tags and Releases; registry publication is outside this release process. If publication stops midway, retain completed checkpoints and resume after inspecting remote state.

**Completion criterion:** branch, tag, and GitHub Release all resolve to the requested version; report the Release URL and any preserved unrelated paths.
