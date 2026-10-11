# Changelog

## [Unreleased]

### Added

- First version (plan unit U1), with these parts:
  - A prediction after each settled run. It uses the session model, a copy of
    the session's last request, and a prefix guard that sends nothing on a
    mismatch.
  - A line above the editor, which Tab accepts.
  - The `/predict` command.
  - The `pi-predict:api.v1` reader and the `predict:updated.v1` event.
  - A price cap, a daily budget, and a pause after two predictions that did
    not read the cache.
  - A log that `/predict stats` reads.
- History (plan unit U2):
  - An incremental index of earlier replies, with BM25 examples in the
    instruction (same project plus short replies from all projects).
  - After a run that ends in an error or an abort, the usual reply from
    history, with no model call.
