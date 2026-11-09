# Releasing

How a version of this package reaches npm. The steady state is two lines long; the
first release has two extra steps because npm's trusted publishing can only be
configured on a package that already exists.

## 1. The first publish — the bootstrap, once

Before anything is on npm:

```bash
npm run smoke:pack        # the tarball: allowlist only, installs, imports, bin runs
npm run smoke:registry    # the real publish code path against a throwaway local registry
```

Both green, then — from your own machine, with 2FA enabled on the npm account, once:

```bash
npm publish --access public
```

`prepublishOnly` runs the build (ts mode), the full `check:all`, and the on-disk
contract check before anything is sent. This is the **only** publish that ever comes
from a laptop. It exists because step 2 cannot happen before it.

## 2. Configure the trusted publisher, once

On npmjs.com → the package → _Settings_ → _Trusted publisher_ → GitHub Actions:

- **Organization or user**: the GitHub owner of this repository
- **Repository**: this repository's name
- **Workflow filename**: `release.yml`
- **Environment**: leave empty
- **Publishing**: allow **direct `npm publish`**. The form labels it "not recommended"
  next to stage-only; `release.yml` requires direct — stage-only would reject the
  publish step _after_ the tag exists and burn the version number. Staged publishing
  (`npm stage publish`, a 2FA approval before a version goes public) is a later phase's
  candidate, adopted deliberately if at all.

That's the credential. There is no token to create, store, scope or rotate — and
nothing to leak. If you ever find an `NPM_TOKEN` secret on this repository, delete it;
the workflow does not use one.

## 3. Every release after that — the ritual

1. Set `version` in `package.json` to the SemVer you intend (`0.2.0` for a feature,
   `0.1.1` for a fix, `1.0.0` when the API is a promise).
2. Merge to `main`.

The release-flow action tags `v<version>`; the workflow runs `npm ci` and
`npm publish --access public`, authenticated by the run's OIDC identity, with
provenance attested automatically — for a **public** repository publishing a public
package; a private repository publishes fine but gets no attestation. The published
version's page on npm shows the commit and workflow that built it.

If you forget the bump, the tag already exists and the action **fails loudly** without
publishing. Bump and merge again. That guard is deliberate.

## 4. A bad version: deprecate, never unpublish

A published version is forever (`unpublish` is blocked after 72 hours and would
break anyone who already installed it). Retire it and roll forward:

```bash
npm deprecate @snackbyte/<name>@<version> "<what is wrong and which version to use>"
```

Then release the fix as a new version by step 3.

## 5. Pre-releases and dist-tags

`latest` is what `npm install` gives people; it must only ever point at a release you
would stand behind. A pre-release goes to another tag:

- Add a channel row to `environments.json` — e.g. `{ "name": "next", "branch": "next",
"tagSuffix": "-next", "isPublicFace": false, "noindex": true }` — and create the branch.
- The action then tags `v<version>-next` for pushes to that branch; give the workflow's
  publish step `--tag next` for that channel so it never becomes `latest`.

## 6. When a run fails after the tag exists

The tag is pushed before the publish step runs, so a red gate leaves a tag with no
version behind it on npm. Fix forward: bump the version and merge again. Do not
re-point or delete the tag. (The exact re-run semantics of the release-flow action are
its `CONSUMING.md`'s to define.)

## What never happens

- `npm publish` from a machine after the bootstrap.
- A long-lived npm token, anywhere.
- `npm unpublish`.
- A `.npmrc` committed to this repository — `smoke:registry` writes one, git-ignored,
  and deletes it; if you see one in `git status`, something was interrupted; delete it.
