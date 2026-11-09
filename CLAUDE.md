# CLAUDE.md — @snackbyte/mail-mcp-server

This is a **published npm package**. Strangers install it; a mistake in the publish
surface reaches them silently and a published version can never be taken back. That
shapes every rule below.

## The publish contract is load-bearing

`package.json`'s `exports`, `files`, `bin`, `engines` and `type` are the interface
consumers depend on. `npm run check:contract` (part of `check:all`) asserts them; do
not weaken or bypass it. In particular:

- `exports` is a map and always includes `./package.json`.
- `files` is an allowlist. Nothing ships that isn't listed; never lean on `.npmignore`.
- `bin` paths are bare (`dist/cli.js` or `src/cli.mjs`, never `./…`) — npm strips the
  prefix on publish and ships no CLI.
- `engines.node` is a floor with no ceiling. A library must install on the next Node.

## The gate stays green at every step

`npm run check:all` — format, lint, typecheck, contract, tests — passes before every
commit, not only at the end. `prepublishOnly` runs it (plus the build in a compiled
package, plus the on-disk contract check) so a red tree cannot be published.

## Test what users get, not the working tree

- `npm run smoke:pack` before any publish: packs the tarball, proves a planted `.env`
  is not in it, installs it into a clean consumer, imports by name, runs the bin.
- `npm run smoke:registry` before the **first** publish: the real `npm publish` code
  path against a throwaway local registry, then an install by name with the package's
  dependencies resolving through a read-only proxy. Nothing is ever published to
  npmjs.org. It writes a project-local `.npmrc` and deletes it; that file is
  git-ignored and must never be committed.

## Releasing

`RELEASING.md` is the runbook. The short form: the first publish is a bootstrap from a
maintainer's machine with 2FA — once, because npm's trusted publisher can only be
configured on a package that exists. After that, a release is _bump `version`, merge
to `main`_; CI publishes by trusted publishing. No npm token exists anywhere and none
should be created. Never `npm publish` from a machine after the bootstrap. Never
`npm unpublish` — deprecate and roll forward.

## What the template does not do yet — report back, don't improvise

This package was spun from `snackbyte-npm-base`. Some things it will eventually need
are the _template's_ to provide, so that every package gets the same answer. If you
find yourself about to build one of these here, stop and say "this is snackbyte-npm-base
Phase N" instead:

- **Automated version bumps and a changelog** (Changesets) — Phase 2. Today the release
  ritual is a manual bump in `package.json`; a forgotten bump fails loudly, a wrong bump
  is your judgment. Do not add a release tool here.
- **A shared, reusable publish workflow** — Phase 2. Today `release.yml` is a copy; a
  template fix reaches this package by a small PR. Do not fork the workflow's logic.
- **Dependabot/Renovate, an install matrix across Node versions, `SECURITY.md`** —
  Phase 3, when strangers depend on the package.
- **Dual ESM/CJS** — never by default; only on a real CJS consumer's demand, recorded in
  this package's spec or plan.
- **Sharing a repository with another releasable** (a library beside a deployed app) —
  covered: the template's `SUBDIR-LAYOUT.md` and the release-flow action's "Two
  releasables in one repository." Follow those; do not invent a layout.

The phase specs live under `specs/` in the template repository.

## Defaults you inherit

From `snackbyte-npm-base`'s constitution: `@snackbyte/*` scope, ESM-only, MIT, Node
`>=24`, SemVer. Deviating from one is allowed with the reason recorded in this
package's spec or plan — never by inertia.

## This package

- **Zero runtime dependencies.** Node built-ins only; everything in `devDependencies` stays there.
  Strangers trust this package with their mail, so a runtime dependency is a decision for the
  maintainer, never a convenience.
- **Nothing personal.** No real addresses, account ids, 1Password items, client names or home
  paths in code, tests, fixtures or docs. Fixtures use `example.com` and made-up domains.
- **Every change to mail stays a plan.** A tool that changes mail or settings is a `plan_*` dry
  run that only `execute_plan` carries out (README, "The safety model"). Do not add a tool that
  acts directly.

Where this package differs from the template, and why:

- Tests run on `node --test`, not the template's test runner: the suite is built on `node:test`
  and needs nothing installed.
- Source imports carry `.ts` extensions (`allowImportingTsExtensions`), and the build rewrites them
  to `.js` (`rewriteRelativeImportExtensions`), so Node runs a clone's source directly with no
  build (`node src/bin.ts`). `erasableSyntaxOnly` keeps the source runnable that way.
- `scripts/smoke-pack.mjs` and `scripts/smoke-registry.mjs` run the bin as `mail-mcp-server
--help`: with no argument it serves MCP on stdin, and `smoke` is not one of its commands.
