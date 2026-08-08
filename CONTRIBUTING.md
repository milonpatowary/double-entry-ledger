# Contributing

Bug reports and pull requests are welcome — especially from anyone who has run this against real
money and found an edge it gets wrong.

## Running the tests

```sh
npm test                  # no services required
```

No framework, no build step. `node --test` on Node 18+.

## Running against a real MongoDB

The unit suite exercises the MongoDB store through a hand-written stand-in. A stand-in agrees with
whatever its author believed, so anything touching `src/stores/mongo.js` must also run against the
real thing:

```sh
docker compose up -d
npm install --no-save mongodb
MONGO_URL=mongodb://127.0.0.1:27017 npm run test:integration
```

The compose file starts a single-node replica set, so transactions are available and the store takes
its transactional path. CI runs both that and a standalone server, because the compensating path is
what most people will actually be on.

## What needs extra care

These carry the guarantees, so a change to any of them should argue its case in the PR description:

- **`store.commit`.** It must apply the entry and the balance deltas atomically against concurrent
  callers. Every guarantee in the README rests on this one method.
- **The balance guard.** It is a conditional update — the filter includes `balance >= -delta` — so
  the check and the write are one operation. Replacing it with a read followed by a write
  reintroduces the race it exists to close, and the failure only appears under concurrency.
- **`fingerprintOf`.** It decides whether a retry is the same entry. Loosening it lets a different
  entry replay silently; tightening it makes honest retries fail.
- **The memory store's critical section.** It is atomic because it performs no `await` between
  validating the guards and applying the writes. Adding one would silently break that.

## Writing tests

Prefer assertions that would fail if the logic were wrong, not merely if it threw. The most valuable
tests here recompute the expected answer independently and compare — see `reconcile` in
`test/ledger.test.js`, which checks the ledger against a fresh sum of its own entries.

Anything concurrency-related should use `Promise.allSettled` over a batch and assert the exact
count that succeeded. "It didn't crash" is not a test of a race.

## Style

No linter is configured; match the surrounding code. Comments should explain *why* — the reasoning
is most of the value in a library like this, and a rule without its rationale is one somebody
deletes next year.
