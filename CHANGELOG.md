# Changelog

This file records the notable changes of each version. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions
follow [Semantic Versioning](https://semver.org/). Before 1.0.0, a minor
version can contain breaking changes.

## [Unreleased]

### Added

- A preview image for the [Pi package gallery](https://pi.dev/packages):
  `pi.image` in `package.json`.

### Fixed

- The README image and the links to `docs/design.md` and `RELEASING.md` work
  on the Pi package gallery. The gallery shows the README from the npm
  package, which does not contain these files, so the README now uses
  absolute URLs.

## [0.1.0] - 2026-10-12

The first public version.

### Added

- A prediction after each settled run. It uses the session model, a copy of
  the session's last request, and a prefix guard that sends nothing on a
  mismatch.
- A line above the editor, which Tab accepts.
- The `/predict` command: the status, and `on`, `off`, `now`, `stats`, and
  `resume`.
- The `pi-predict:api.v1` reader and the `predict:updated.v1` event.
- A price cap, a daily budget, and a pause after two predictions that did not
  read the cache.
- A log that `/predict stats` reads.
- History: an incremental index of earlier replies, with BM25 examples in the
  instruction. The scopes are `project` (the default), `project+short`, `all`,
  and `off`. After a run that ends in an error or an abort, pi-predict offers
  the usual reply from history, with no model call.
- Stock Pi 0.87.1 and later. Where a Pi build has them, pi-predict also uses
  pi-ai's `fitImagesToInputLimits` and the `session_context_window` event.
