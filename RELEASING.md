# Releasing

One tag, `vX.Y.Z`, makes a release on two channels:

- git: `pi install git:github.com/eddiewang/pi-predict@vX.Y.Z` works when the
  tag is on GitHub.
- npm: the tag stages `@eddiewang/pi-predict@X.Y.Z`. The version is public
  only after a maintainer approves it with 2FA.

## Rules

- Tag only a commit on `main` that you used in your own Pi for at least one
  day. CI tests stock Pi, but each prediction costs money, so real use is the
  last check.
- The workflow can only stage a version. GitHub holds no npm token, and npm
  takes no token for this package. Each public version has a maintainer's 2FA
  approval and a provenance attestation.
- Do not move a tag after npm made its version public.

## Release a version

1. Prepare the release commit on `main`:
   1. Set the version: `npm version X.Y.Z --no-git-tag-version`.
   2. In `CHANGELOG.md`, change `## [Unreleased]` to
      `## [X.Y.Z] - YYYY-MM-DD`. Then add a new, empty `## [Unreleased]`
      above it.
   3. Run `npm ci && npm run check && npm test && npm run smoke`.
   4. Commit ("release: X.Y.Z"), push `main`, and wait for green CI.
2. Use that commit in your own Pi for at least one day. For example:
   `pi install git:github.com/eddiewang/pi-predict@<sha>`.
3. Tag that commit and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z" <sha>
   git push origin vX.Y.Z
   ```

4. The [Release workflow](.github/workflows/release.yml) runs:
   1. `verify` makes sure that the tag, `package.json`, and `CHANGELOG.md`
      name the same version and that the commit is on `main`. Then it runs
      the checks, the tests, and the smoke test.
   2. `publish` runs `npm stage publish --provenance` with npm trusted
      publishing (OIDC). Then it creates the GitHub release from the
      CHANGELOG section.
5. Examine the staged version. The workflow log gives the stage id.

   ```sh
   npm stage list @eddiewang/pi-predict
   npm stage view <stage-id>
   npm stage download <stage-id>
   ```

   The tarball must hold `package.json`, `README.md`, `CHANGELOG.md`,
   `LICENSE`, and `src/`, and nothing more. Compare `src/` with the tag.
6. Approve the stage with 2FA: `npm stage approve <stage-id>`, or click
   **Approve** in the **Staged Packages** tab on npmjs.com.
7. Check the release:
   - `npm view @eddiewang/pi-predict@X.Y.Z dist.attestations` shows a
     provenance attestation.
   - `pi install npm:@eddiewang/pi-predict@X.Y.Z` registers `/predict`.

If your npm configuration sends the `@eddiewang` scope to a different
registry, add `--@eddiewang:registry=https://registry.npmjs.org/` to the npm
commands.

## When a step fails

- `verify` or `publish` fails, or the staged version is wrong: the version is
  not public yet.
  1. If npm has a stage, reject it: `npm stage reject <stage-id>` (2FA).
  2. If GitHub has a release, delete it:
     `gh release delete vX.Y.Z --repo eddiewang/pi-predict`.
  3. Delete the tag: `git push --delete origin vX.Y.Z`, then
     `git tag -d vX.Y.Z`.
  4. Correct the problem on `main`, then do the release steps again. You can
     keep the version number, because npm removes a rejected stage.
- A public version is wrong: in the first 72 hours, remove it with
  `npm unpublish @eddiewang/pi-predict@X.Y.Z`. After that, deprecate it with
  `npm deprecate @eddiewang/pi-predict@X.Y.Z "<reason>"`. Then release a
  fix. npm never accepts a version number again after an unpublish.

## Setup (one time)

npm can add a trusted publisher only to a package that exists. The first
`npm stage publish` of a new package creates the public placeholder version
`0.0.0-stage`. The workflow cannot do that first stage, because it has no
trusted publisher yet, so a maintainer does it once:

1. Create the package from your machine:
   1. Run `npm login` (2FA).
   2. In a temporary copy of the release commit, set a throwaway version:
      `npm version 0.0.0-bootstrap.0 --no-git-tag-version`.
   3. Run `npm stage publish --tag bootstrap`. A prerelease version needs a
      `--tag`.
   4. Reject that stage: find its id with
      `npm stage list @eddiewang/pi-predict`, then run
      `npm stage reject <stage-id>`.

   If npm refuses to stage a new package, publish the first version with
   `npm publish` and 2FA instead. That version has no provenance.
2. On npmjs.com, open the package settings. Add a trusted publisher:
   GitHub Actions, user `eddiewang`, repository `pi-predict`, workflow
   `release.yml`, no environment. Do not allow `npm publish` or
   `npm dist-tag`; `npm stage publish` is always allowed.
3. Set **Publishing access** to "Require two-factor authentication and
   disallow tokens".
4. A new trusted publisher expires if no publish uses it in 2 days. Push the
   first tag on the same day.
5. On GitHub, a ruleset lets only maintainers create `v*` tags, and a run of
   a workflow from an outside contributor needs approval.
