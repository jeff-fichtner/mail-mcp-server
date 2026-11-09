#!/usr/bin/env node
/**
 * The publish-contract check (Constitution II). The `package.json` publish surface is
 * what strangers depend on and most of its failure modes are silent — a wrong `exports`
 * breaks consumers with no error here; a `bin` path with a "./" prefix is stripped by
 * the registry and ships a package with no CLI. This asserts the contract so drift
 * fails in CI, not on npmjs.org.
 *
 *   node scripts/check-publish-contract.mjs [--cwd <dir>] [--exists]
 *
 * Shape checks always run. `--exists` additionally asserts every `files` entry and every
 * `bin` path exists on disk — meaningful after a build, so `prepublishOnly` runs it and
 * `check:all` does not. Exit 1 listing every failure; exit 0 silently.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';

const args = process.argv.slice(2);
let cwd = process.cwd();
let checkExists = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--cwd') cwd = resolve(args[++i] ?? '');
  else if (args[i] === '--exists') checkExists = true;
  else {
    console.error(`Usage: node scripts/check-publish-contract.mjs [--cwd <dir>] [--exists]`);
    process.exit(1);
  }
}

const pkgPath = join(cwd, 'package.json');
if (!existsSync(pkgPath)) {
  console.error(`check:contract — no package.json at ${cwd}`);
  process.exit(1);
}
/** @type {Record<string, any>} */
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

/** @type {string[]} */
const failures = [];
/** @param {string} field @param {string} rule */
const fail = (field, rule) => failures.push(`${field}: ${rule}`);

// name — scoped, so it lands in the org namespace (Principle V). A `private: true`
// package is never published, so its name is not part of the publish contract; that is
// what lets the template itself (named with a placeholder) pass this check.
if (
  pkg.private !== true &&
  (typeof pkg.name !== 'string' || !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(pkg.name))
) {
  fail('name', 'must be a scoped, lowercase npm name (@scope/name)');
}

// type — ESM-only
if (pkg.type !== 'module') fail('type', 'must be "module" (ESM-only)');

// exports — a map, with "." and "./package.json"
if (pkg.exports === undefined || typeof pkg.exports !== 'object' || Array.isArray(pkg.exports)) {
  fail('exports', 'must be an exports map (not just "main")');
} else {
  if (!('.' in pkg.exports)) fail('exports["."]', 'the library entry is missing');
  if (!('./package.json' in pkg.exports)) {
    fail(
      'exports["./package.json"]',
      'must be exported so tooling can read it under a strict exports map',
    );
  }
}

// files — an allowlist, never .npmignore
if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
  fail('files', 'must be a non-empty allowlist (never rely on .npmignore)');
}

// bin — bare relative paths; npm silently strips a "./" prefix on publish
if (pkg.bin !== undefined) {
  const entries =
    typeof pkg.bin === 'string' ? [[pkg.name.split('/')[1], pkg.bin]] : Object.entries(pkg.bin);
  for (const [key, value] of entries) {
    if (typeof value !== 'string' || value === '') fail(`bin["${key}"]`, 'must be a path');
    else if (value.startsWith('./') || value.startsWith('../') || isAbsolute(value)) {
      fail(
        `bin["${key}"]`,
        `must be a bare relative path (got "${value}"); npm strips a "./" prefix on publish and ships no CLI`,
      );
    }
  }
}

// engines — a floor with no ceiling; a library must install on the next Node
const engine = pkg.engines?.node;
if (typeof engine !== 'string' || engine.trim() === '') {
  fail('engines.node', 'must be set (the snackbyte floor is ">=24")');
} else if (engine.includes('<')) {
  fail(
    'engines.node',
    `must not have an upper bound (got "${engine}") — a library must install on the next Node; a bound is a recorded deviation from Principle V`,
  );
}

// prepublishOnly — the gate a stale or broken artifact cannot pass
const pre = pkg.scripts?.prepublishOnly;
if (typeof pre !== 'string' || !pre.includes('check:all')) {
  fail('scripts.prepublishOnly', 'must run check:all (and the build, when there is one)');
}

// --exists: the artifact's inputs are actually on disk
if (checkExists && failures.length === 0) {
  for (const entry of pkg.files) {
    if (!existsSync(join(cwd, entry))) fail(`files["${entry}"]`, 'does not exist on disk');
  }
  if (pkg.bin !== undefined) {
    const values = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin);
    for (const value of values) {
      if (!existsSync(join(cwd, value)))
        fail(`bin → ${value}`, 'does not exist on disk (build first?)');
    }
  }
}

if (failures.length > 0) {
  console.error(`check:contract — ${failures.length} problem(s) in ${pkgPath}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
