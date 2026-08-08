# double-entry-ledger

**A double-entry ledger for Node and MongoDB.** Balanced by construction, append-only, idempotent,
and reconcilable — so the books cannot quietly go wrong.

[![CI](https://github.com/milonpatowary/double-entry-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/milonpatowary/double-entry-ledger/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/double-entry-ledger.svg)](https://www.npmjs.com/package/double-entry-ledger)
[![license](https://img.shields.io/npm/l/double-entry-ledger.svg)](./LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)

```js
await ledger.post({
  description: 'Card deposit',
  idempotencyKey: 'deposit-001',
  postings: [
    { account: 'platform:bank',     debit: 5000 },   // an asset rises
    { account: 'user:alice:wallet', credit: 5000 }   // and so does what you owe
  ]
})
```

Debits must equal credits. If they don't, nothing is written.

---

## The problem

Almost every application that handles money starts the same way:

```js
await users.updateOne({ _id }, { $inc: { balance: amount } })
```

It works. It keeps working. Then one day the number is wrong and there is no way to find out why,
because the only record of what the balance *should* be is the balance itself.

The specific ways it goes wrong:

- **A retry doubles a credit.** The HTTP request timed out, the client retried, the handler ran twice.
- **A half-finished transfer.** One `$inc` succeeded, the other threw, and now money exists in one
  place and not the other. Nothing records that this happened.
- **Floating point.** `0.1 + 0.2` is `0.30000000000000004`. Accumulate that across a million rows.
- **A negative balance nobody bounded.** Two withdrawals raced, both read a sufficient balance, both
  proceeded.
- **"Where did this £40 come from?"** There is no answer. There is only a number.

Double-entry bookkeeping is the 500-year-old fix. Every movement touches at least two accounts and
the two sides must agree, so the books carry their own proof. This library is that discipline,
enforced by code rather than by remembering.

---

## Install

```sh
npm install double-entry-ledger
```

Zero runtime dependencies. Node 18+. MongoDB is optional — the in-memory store is a first-class
citizen and the whole test suite runs against it.

---

## Quick start

```js
const { createLedger, createMemoryStore } = require('double-entry-ledger')

const ledger = createLedger({ store: createMemoryStore() })

// A customer's balance is a LIABILITY: it is money you owe them.
// Your bank account is an ASSET. Getting that pairing right is what makes a
// deposit balance — it increases both sides of the equation at once.
await ledger.createAccount({ id: 'platform:bank',     type: 'asset',     currency: 'USD' })
await ledger.createAccount({ id: 'user:alice:wallet', type: 'liability', currency: 'USD' })

await ledger.post({
  postings: [
    { account: 'platform:bank',     debit: 5000 },
    { account: 'user:alice:wallet', credit: 5000 }
  ]
})

await ledger.balance('user:alice:wallet')
// { account: 'user:alice:wallet', currency: 'USD', balance: 5000, formatted: '50.00 USD', ... }
```

Run the full worked example — deposit, retry, split payment with a fee, refused overdraft,
chargeback, trial balance, reconciliation:

```sh
npm run example
```

---

## What it guarantees

| | |
|---|---|
| **Every entry balances** | Debits equal credits exactly, in integer minor units. An unbalanced entry is refused, never adjusted into shape. |
| **Nothing is ever edited** | Entries are append-only. A mistake is corrected with a reversing entry, so both the error and the correction stay visible. |
| **A retry is not a double-spend** | `idempotencyKey` is claimed atomically. Post the same key twice and the second call returns the first entry, having written nothing. |
| **A guarded account cannot go negative** | Enforced by an atomic conditional update, not by reading the balance and hoping. Concurrent withdrawals cannot both pass. |
| **Money is never a float** | Amounts are integer minor units. A float is rejected at the boundary rather than silently rounded. |
| **One currency per entry** | Cross-currency movement needs explicit FX postings, because an implicit conversion is a rate nobody recorded. |
| **The balances are checkable** | `reconcile()` recomputes every balance from the entries and reports drift. Balances are a cache; entries are the truth. |

---

## Debits and credits, briefly

The part that trips up programmers: **a debit is not "money in".**

Debits and credits are just the two sides of one equation:

```
assets + expenses  =  liabilities + equity + revenue
```

A debit increases the left side and decreases the right. So a debit increases your bank account (an
asset) and *decreases* what you owe a customer (a liability).

| Type | Increased by | Typical use |
|---|---|---|
| `asset` | debit | your bank account, cash, receivables |
| `expense` | debit | fees you pay, costs |
| `liability` | credit | **customer balances**, payables |
| `equity` | credit | owner capital, retained earnings |
| `revenue` | credit | your fees, sales |

The library records which direction is normal for each type, so `balance()` returns a number that
reads the way you expect. A customer's wallet shows `5000` when they have $50 — not `-5000` that
everyone then remembers to flip.

**A customer's wallet is a liability, not an asset.** It is the single most common modelling
mistake, and getting it right is what makes deposits balance.

---

## Guarded accounts

Liability accounts are guarded by default — a customer cannot spend money they do not have:

```js
await ledger.post({
  postings: [
    { account: 'user:alice:wallet', debit: 10000 },
    { account: 'platform:bank',    credit: 10000 }
  ]
})
// InsufficientFundsError: Account "user:alice:wallet" has 3750 available
// but 10000 was requested (USD, minor units).
```

Everything else is unguarded, deliberately: a bank account can be overdrawn, revenue goes negative
when refunds exceed sales, and equity goes negative as an accumulated deficit. Guarding those would
reject correct bookkeeping. Override per account with `allowNegative`.

The guard is an **atomic conditional update** — the store only moves the balance when the result
would stay at or above zero. Reading the balance and then deciding is the bug this avoids: two
simultaneous withdrawals both read a sufficient balance and both proceed. There is a test for
exactly that, and it asserts that ten concurrent withdrawals against five withdrawals of funds
result in precisely five.

---

## Correcting mistakes

There is no `update` and no `delete`. A wrong entry is corrected by reversing it:

```js
await ledger.reverse(entry.id, { description: 'Chargeback' })
```

That writes the mirror image and leaves the original untouched. Both are permanently visible.

This is not squeamishness about deletion. An audit that cannot see the mistake cannot see that it
was caught, and *"the number changed and nobody knows why"* is the failure being traded away.
`reverse()` is idempotent — calling it twice returns the same reversal.

---

## Reconciliation

Balances are a **cache** over the entries. This is what makes that claim checkable rather than
merely stated:

```js
const report = await ledger.reconcile()
// { entries: 41_233, accounts: 512, balanced: true, drift: [], totals: { USD: {...} } }

await ledger.reconcile({ repair: true })   // rebuild the cache from the entries
```

It recomputes every balance from every entry, re-checks that each entry balances on the way past,
and reports any account whose cached balance disagrees. **Run it on a schedule.** A cache nobody
verifies is a cache that is eventually wrong without anyone noticing — and finding out from a
customer is the expensive way.

`trialBalance()` gives the classic report: every active account in its normal column, with the two
totals that must agree.

---

## Stores

### Memory (default)

```js
createLedger({ store: createMemoryStore() })
```

Real implementation, not a mock — it enforces the same guarded commit, and the whole test suite runs
against it. Single process only, and nothing survives a restart.

### MongoDB

```js
const { MongoClient } = require('mongodb')
const client = new MongoClient(process.env.MONGO_URL)
await client.connect()

createLedger({
  store: createMongoStore({ db: client.db('app'), client })
})
```

Three collections: `accounts`, `entries`, `balances`. Indexes are created on first use.

**An entry's postings live inside one document.** That is the central design choice: a
single-document write is atomic in MongoDB with no transaction and no replica set, so *"all of an
entry's postings land, or none do"* is true by construction. Splitting postings into their own
collection would make the core invariant depend on a transaction being available.

**Pass `client` if you can.** With it, the store uses a transaction to move the balance cache and
write the entry together. Without it — or on a standalone `mongod`, where transactions are
unavailable — the store moves the guarded balances first, writes the entry, and compensates if the
write fails. If the process dies between the two, the cache is ahead of the entries; the ledger is
still correct, and `reconcile()` finds and repairs it. That is the honest cost of running without a
replica set, and it is why reconciliation is a first-class feature rather than optional hygiene.

### Your own

Implement the store interface (see `src/stores/memory.js` — it is short). The one hard requirement
is that `commit` be atomic against concurrent callers; every guarantee above rests on it.

---

## What this is not

- **Not an accounting system.** No chart of accounts, no periods, no tax, no reporting beyond a
  trial balance. It is the substrate those are built on.
- **Not multi-currency.** One currency per entry, by design. Cross-currency movement goes through
  explicit FX postings against a conversion account, so the rate you used is recorded rather than
  implied.
- **Not a payments integration.** It records what happened; talking to Stripe is your job.
- **Not a replacement for your database's durability.** Use MongoDB with a replica set and tested
  backups. A ledger on one unbacked box is a ledger you will lose.

---

## Testing

```sh
npm test                  # 68 tests, no services required
```

No test framework, no build step, no service dependencies. The store contract runs against both the
memory store and a MongoDB stand-in faithful enough to enforce unique indexes and honour the
`$gte` filter the balance guard depends on — because the guarded commit is the most delicate code
here and shipping it unexercised was not an option.

The same contract runs against a real `mongod` in CI on every push:

```sh
docker compose up -d
MONGO_URL=mongodb://127.0.0.1:27017 npm run test:integration
```

---

## Support this project

Free, MIT-licensed, maintained in spare time. If it saved you a reconciliation nightmare:

**[❤️ Sponsor](https://github.com/sponsors/milonpatowary)** · **[☕ Ko-fi](https://ko-fi.com/milonpatowary)** · [crypto and other ways](./DONATE.md)

Never expected, never a condition of support — issues and PRs get the same attention from everyone.

I also take on [retained development and platform ownership work](https://zexabit.com) for teams
building systems where this class of problem matters.

---

## License

MIT © [Milon Patowary](https://github.com/milonpatowary)
