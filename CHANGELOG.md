# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — unreleased

Initial release.

### Added

- `createLedger({ store })` with accounts, entries, balances and reconciliation.
- **Balanced by construction.** Debits must equal credits exactly, in integer minor units. An
  unbalanced entry is refused, never adjusted into shape.
- **Append-only.** No update, no delete. `reverse()` writes the mirror image and leaves the original
  intact, so a mistake and its correction are both permanently visible. Reversal is idempotent.
- **Idempotency.** An `idempotencyKey` is claimed atomically — via a unique index on MongoDB — so a
  retry returns the original entry rather than posting twice. A key reused for different money is a
  conflict rather than a silent replay.
- **Guarded balances.** Liability accounts cannot go below zero by default, enforced with an atomic
  conditional update rather than a read-then-write. Assets, revenue and equity are unguarded,
  because an overdrawn bank account, refunds exceeding sales, and an accumulated deficit are all
  legitimate bookkeeping.
- **Integer money.** Amounts are integer minor units; a float is rejected at the boundary rather
  than rounded. Formatting knows the per-currency exponent, so JPY and KWD are not assumed to have
  two decimal places.
- **One currency per entry**, with cross-currency movement pushed through explicit FX postings.
- `reconcile()` recomputes every balance from the entries, re-checks that each entry balances, and
  reports or repairs drift. `trialBalance()` produces the classic report.
- Stores: in-memory (default) and MongoDB. An entry's postings live in one document, so their
  atomicity needs no transaction. The MongoDB store uses a transaction for the balance cache when a
  client is supplied and the deployment allows it, and a compensating path otherwise.
- TypeScript definitions.
- Zero runtime dependencies.

[Unreleased]: https://github.com/milonpatowary/double-entry-ledger/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/milonpatowary/double-entry-ledger/releases/tag/v0.1.0
