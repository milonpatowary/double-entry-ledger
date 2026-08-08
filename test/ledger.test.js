'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createLedger,
  createMemoryStore,
  UnbalancedEntryError,
  UnknownAccountError,
  CurrencyMismatchError,
  InsufficientFundsError,
  IdempotencyConflictError,
  LedgerError
} = require('../src/index')

/**
 * A ledger for a small platform holding customer funds.
 *
 * `platform:bank` is an asset — real money you hold. `user:*:wallet` are
 * liabilities, because a customer's balance is money you owe them. Getting that
 * pairing right is what makes the equation work: taking a deposit increases
 * both an asset and a liability, and the books stay balanced.
 */
async function fixture () {
  const store = createMemoryStore()
  let seq = 0
  const ledger = createLedger({
    store,
    now: () => new Date(Date.UTC(2026, 0, 1) + seq * 1000),
    generateId: () => `e${String(++seq).padStart(4, '0')}`
  })

  await ledger.createAccount({ id: 'platform:bank', type: 'asset', currency: 'USD' })
  await ledger.createAccount({ id: 'platform:revenue', type: 'revenue', currency: 'USD' })
  await ledger.createAccount({ id: 'user:1:wallet', type: 'liability', currency: 'USD' })
  await ledger.createAccount({ id: 'user:2:wallet', type: 'liability', currency: 'USD' })

  return { ledger, store }
}

const deposit = (user, amount) => ({
  description: `Deposit for ${user}`,
  postings: [
    { account: 'platform:bank', debit: amount },
    { account: `${user}:wallet`, credit: amount }
  ]
})

/* ---------------------------------------------------------------- *
 * The invariant
 * ---------------------------------------------------------------- */

test('a balanced entry is accepted and moves both sides', async () => {
  const { ledger } = await fixture()
  const entry = await ledger.post(deposit('user:1', 5000))

  assert.equal(entry.amount, 5000)
  assert.equal(entry.currency, 'USD')
  assert.equal(entry.postings.length, 2)

  const bank = await ledger.balance('platform:bank')
  const wallet = await ledger.balance('user:1:wallet')

  // The asset rises with a debit; the liability rises with a credit. Both read
  // positive, which is the point of tracking normal direction per account type.
  assert.equal(bank.balance, 5000)
  assert.equal(wallet.balance, 5000)
  assert.equal(bank.formatted, '50.00 USD')
})

test('an unbalanced entry is refused, not adjusted', async () => {
  const { ledger, store } = await fixture()

  await assert.rejects(
    ledger.post({
      postings: [
        { account: 'platform:bank', debit: 5000 },
        { account: 'user:1:wallet', credit: 4999 }
      ]
    }),
    (err) => {
      assert.ok(err instanceof UnbalancedEntryError)
      assert.equal(err.code, 'unbalanced_entry')
      assert.equal(err.difference, 1)
      return true
    }
  )

  assert.equal(store._counts().entries, 0, 'nothing was written')
  assert.equal((await ledger.balance('platform:bank')).balance, 0, 'no balance moved')
})

test('a single-sided entry is refused', async () => {
  const { ledger } = await fixture()
  await assert.rejects(
    ledger.post({ postings: [{ account: 'platform:bank', debit: 100 }] }),
    /at least two postings/
  )
})

test('a posting must be exactly one of debit or credit', async () => {
  const { ledger } = await fixture()

  await assert.rejects(
    ledger.post({
      postings: [
        { account: 'platform:bank', debit: 100, credit: 100 },
        { account: 'user:1:wallet', credit: 100 }
      ]
    }),
    /specified both/
  )

  await assert.rejects(
    ledger.post({
      postings: [{ account: 'platform:bank' }, { account: 'user:1:wallet', credit: 100 }]
    }),
    /specified neither/
  )
})

test('multi-posting entries balance across more than two accounts', async () => {
  const { ledger } = await fixture()

  // A 50.00 payment split into 45.00 to the user and 5.00 of fee revenue.
  await ledger.post({
    description: 'Payment with fee',
    postings: [
      { account: 'platform:bank', debit: 5000 },
      { account: 'user:1:wallet', credit: 4500 },
      { account: 'platform:revenue', credit: 500 }
    ]
  })

  assert.equal((await ledger.balance('platform:bank')).balance, 5000)
  assert.equal((await ledger.balance('user:1:wallet')).balance, 4500)
  assert.equal((await ledger.balance('platform:revenue')).balance, 500)

  const tb = await ledger.trialBalance()
  assert.equal(tb.balanced, true, 'the trial balance still agrees')
})

/* ---------------------------------------------------------------- *
 * Money discipline
 * ---------------------------------------------------------------- */

test('a float amount is refused rather than rounded', async () => {
  const { ledger } = await fixture()
  await assert.rejects(
    ledger.post({
      postings: [
        { account: 'platform:bank', debit: 50.5 },
        { account: 'user:1:wallet', credit: 50.5 }
      ]
    }),
    (err) => {
      assert.equal(err.code, 'invalid_amount')
      assert.match(err.message, /integer number of minor units/)
      return true
    }
  )
})

test('zero and negative amounts are refused; direction comes from debit/credit', async () => {
  const { ledger } = await fixture()

  await assert.rejects(
    ledger.post({
      postings: [
        { account: 'platform:bank', debit: 0 },
        { account: 'user:1:wallet', credit: 0 }
      ]
    }),
    /greater than zero/
  )

  await assert.rejects(
    ledger.post({
      postings: [
        { account: 'platform:bank', debit: -100 },
        { account: 'user:1:wallet', credit: -100 }
      ]
    }),
    /greater than zero/
  )
})

/* ---------------------------------------------------------------- *
 * Accounts
 * ---------------------------------------------------------------- */

test('an unknown account is refused, never auto-created', async () => {
  const { ledger, store } = await fixture()

  await assert.rejects(
    ledger.post({
      postings: [
        { account: 'platform:bank', debit: 100 },
        { account: 'user:1:walet', credit: 100 } // typo
      ]
    }),
    (err) => {
      assert.ok(err instanceof UnknownAccountError)
      assert.equal(err.accountId, 'user:1:walet')
      return true
    }
  )

  assert.equal(store._counts().accounts, 4, 'the typo did not open an account')
})

test('an entry cannot mix currencies', async () => {
  const { ledger } = await fixture()
  await ledger.createAccount({ id: 'user:3:wallet', type: 'liability', currency: 'EUR' })

  await assert.rejects(
    ledger.post({
      postings: [
        { account: 'platform:bank', debit: 100 },
        { account: 'user:3:wallet', credit: 100 }
      ]
    }),
    (err) => {
      assert.ok(err instanceof CurrencyMismatchError)
      assert.equal(err.expected, 'USD')
      assert.equal(err.found, 'EUR')
      return true
    }
  )
})

test('creating the same account twice is refused', async () => {
  const { ledger } = await fixture()
  await assert.rejects(
    ledger.createAccount({ id: 'platform:bank', type: 'asset', currency: 'USD' }),
    /already exists/
  )
})

test('only liabilities are guarded by default', async () => {
  const { ledger } = await fixture()

  // The customer wallet is the one that must not go negative.
  assert.equal((await ledger.getAccount('user:1:wallet')).allowNegative, false)

  // These all legitimately go negative: an overdrawn bank, refunds exceeding
  // sales, an accumulated deficit. Guarding them would reject correct books.
  assert.equal((await ledger.getAccount('platform:bank')).allowNegative, true)
  assert.equal((await ledger.getAccount('platform:revenue')).allowNegative, true)

  await ledger.createAccount({ id: 'equity:retained', type: 'equity', currency: 'USD' })
  assert.equal((await ledger.getAccount('equity:retained')).allowNegative, true)

  // And the default is overridable either way.
  await ledger.createAccount({
    id: 'user:9:wallet', type: 'liability', currency: 'USD', allowNegative: true
  })
  assert.equal((await ledger.getAccount('user:9:wallet')).allowNegative, true)

  await ledger.createAccount({
    id: 'platform:reserve', type: 'asset', currency: 'USD', allowNegative: false
  })
  assert.equal((await ledger.getAccount('platform:reserve')).allowNegative, false)
})

/* ---------------------------------------------------------------- *
 * Guarded balances
 * ---------------------------------------------------------------- */

test('a guarded account cannot be overdrawn', async () => {
  const { ledger } = await fixture()
  await ledger.post(deposit('user:1', 5000))

  await assert.rejects(
    ledger.post({
      description: 'Withdraw too much',
      postings: [
        { account: 'user:1:wallet', debit: 5001 },
        { account: 'platform:bank', credit: 5001 }
      ]
    }),
    (err) => {
      assert.ok(err instanceof InsufficientFundsError)
      assert.equal(err.available, 5000)
      assert.equal(err.requested, 5001)
      return true
    }
  )

  assert.equal((await ledger.balance('user:1:wallet')).balance, 5000, 'balance untouched')
  assert.equal((await ledger.balance('platform:bank')).balance, 5000, 'and so is the other side')
})

test('spending exactly the full balance is allowed', async () => {
  const { ledger } = await fixture()
  await ledger.post(deposit('user:1', 5000))
  await ledger.post({
    postings: [
      { account: 'user:1:wallet', debit: 5000 },
      { account: 'platform:bank', credit: 5000 }
    ]
  })
  assert.equal((await ledger.balance('user:1:wallet')).balance, 0)
})

test('an unguarded account may go negative', async () => {
  const { ledger } = await fixture()
  await ledger.post({
    description: 'Bank goes overdrawn',
    postings: [
      { account: 'platform:bank', credit: 2500 },
      { account: 'platform:revenue', debit: 2500 }
    ]
  })
  assert.equal((await ledger.balance('platform:bank')).balance, -2500)
})

/* ---------------------------------------------------------------- *
 * Idempotency
 * ---------------------------------------------------------------- */

test('replaying an idempotency key applies the entry once', async () => {
  const { ledger, store } = await fixture()

  const first = await ledger.post({ ...deposit('user:1', 5000), idempotencyKey: 'dep-1' })
  const second = await ledger.post({ ...deposit('user:1', 5000), idempotencyKey: 'dep-1' })

  assert.equal(first.id, second.id, 'the same entry is returned')
  assert.equal(store._counts().entries, 1, 'only one entry exists')
  assert.equal((await ledger.balance('user:1:wallet')).balance, 5000, 'applied once, not twice')
})

test('posting order does not defeat idempotency', async () => {
  const { ledger, store } = await fixture()

  await ledger.post({
    idempotencyKey: 'dep-1',
    postings: [
      { account: 'platform:bank', debit: 5000 },
      { account: 'user:1:wallet', credit: 5000 }
    ]
  })
  await ledger.post({
    idempotencyKey: 'dep-1',
    postings: [
      { account: 'user:1:wallet', credit: 5000 },
      { account: 'platform:bank', debit: 5000 }
    ]
  })

  assert.equal(store._counts().entries, 1, 'the same entry written two ways is one entry')
})

test('the same key for a different amount is a conflict', async () => {
  const { ledger, store } = await fixture()
  await ledger.post({ ...deposit('user:1', 5000), idempotencyKey: 'dep-1' })

  await assert.rejects(
    ledger.post({ ...deposit('user:1', 9999), idempotencyKey: 'dep-1' }),
    (err) => {
      assert.ok(err instanceof IdempotencyConflictError)
      return true
    }
  )

  assert.equal(store._counts().entries, 1)
  assert.equal((await ledger.balance('user:1:wallet')).balance, 5000)
})

test('a differing description is not a conflict — only the money counts', async () => {
  const { ledger, store } = await fixture()
  await ledger.post({ ...deposit('user:1', 5000), description: 'Deposit', idempotencyKey: 'dep-1' })
  await ledger.post({ ...deposit('user:1', 5000), description: 'Card deposit', idempotencyKey: 'dep-1' })
  assert.equal(store._counts().entries, 1)
})

/* ---------------------------------------------------------------- *
 * Append-only and reversal
 * ---------------------------------------------------------------- */

test('a reversal mirrors the original and restores the balances', async () => {
  const { ledger, store } = await fixture()
  const original = await ledger.post(deposit('user:1', 5000))

  const reversal = await ledger.reverse(original.id, { description: 'Chargeback' })

  assert.equal(reversal.reverses, original.id)
  assert.equal((await ledger.balance('user:1:wallet')).balance, 0)
  assert.equal((await ledger.balance('platform:bank')).balance, 0)

  // Both entries survive: the mistake and its correction are both visible.
  assert.equal(store._counts().entries, 2)
  const kept = await ledger.getEntry(original.id)
  assert.deepEqual(kept.postings, original.postings, 'the original is untouched')
})

test('reversing twice returns the same reversal', async () => {
  const { ledger, store } = await fixture()
  const original = await ledger.post(deposit('user:1', 5000))

  const a = await ledger.reverse(original.id)
  const b = await ledger.reverse(original.id)

  assert.equal(a.id, b.id)
  assert.equal(store._counts().entries, 2, 'not reversed twice')
  assert.equal((await ledger.balance('user:1:wallet')).balance, 0)
})

test('a reversing entry cannot itself be reversed', async () => {
  const { ledger } = await fixture()
  const original = await ledger.post(deposit('user:1', 5000))
  const reversal = await ledger.reverse(original.id)

  await assert.rejects(ledger.reverse(reversal.id), /reverse the original instead/)
})

test('reversal respects guards — it cannot overdraw either', async () => {
  const { ledger } = await fixture()
  await ledger.post(deposit('user:1', 5000))
  const spend = await ledger.post({
    postings: [
      { account: 'user:1:wallet', debit: 5000 },
      { account: 'platform:revenue', credit: 5000 }
    ]
  })

  // The wallet is at zero. Reversing the deposit would take it to -5000.
  const deposits = await ledger.listEntries({ account: 'user:1:wallet' })
  await assert.rejects(ledger.reverse(deposits[0].id), InsufficientFundsError)
  assert.ok(spend.id)
})

test('entries handed out are copies, so the ledger cannot be mutated through them', async () => {
  const { ledger } = await fixture()
  const entry = await ledger.post(deposit('user:1', 5000))

  entry.postings[0].debit = 999999
  entry.amount = 999999

  const stored = await ledger.getEntry(entry.id)
  assert.equal(stored.postings[0].debit, 5000)
  assert.equal(stored.amount, 5000)
})

/* ---------------------------------------------------------------- *
 * Reconciliation
 * ---------------------------------------------------------------- */

test('reconcile reports no drift on a healthy ledger', async () => {
  const { ledger } = await fixture()
  await ledger.post(deposit('user:1', 5000))
  await ledger.post(deposit('user:2', 2500))
  await ledger.post({
    postings: [
      { account: 'user:1:wallet', debit: 1000 },
      { account: 'platform:revenue', credit: 1000 }
    ]
  })

  const report = await ledger.reconcile()
  assert.equal(report.entries, 3)
  assert.equal(report.balanced, true)
  assert.deepEqual(report.drift, [])
  assert.equal(report.totals.USD.debits, report.totals.USD.credits)
})

test('reconcile detects a corrupted balance cache, and repairs it on request', async () => {
  const { ledger, store } = await fixture()
  await ledger.post(deposit('user:1', 5000))

  // Simulate the failure the compensation path can leave behind: the cache
  // moved but the entry did not.
  await store.replaceBalances([
    { account: 'user:1:wallet', balance: 7777, debits: 0, credits: 7777, currency: 'USD' }
  ])

  const found = await ledger.reconcile()
  assert.equal(found.drift.length, 1)
  assert.equal(found.drift[0].account, 'user:1:wallet')
  assert.equal(found.drift[0].cached.balance, 7777)
  assert.equal(found.drift[0].computed.balance, 5000)
  assert.equal(found.drift[0].difference, -2777)

  const repaired = await ledger.reconcile({ repair: true })
  assert.equal(repaired.repaired, 1)
  assert.equal((await ledger.balance('user:1:wallet')).balance, 5000)

  const after = await ledger.reconcile()
  assert.deepEqual(after.drift, [], 'clean afterwards')
})

test('a trial balance agrees, and lists each side in its normal column', async () => {
  const { ledger } = await fixture()
  await ledger.post(deposit('user:1', 5000))
  await ledger.post(deposit('user:2', 2500))

  const tb = await ledger.trialBalance()
  assert.equal(tb.balanced, true)
  assert.equal(tb.totals.debits, 7500)
  assert.equal(tb.totals.credits, 7500)

  const bank = tb.rows.find((r) => r.account === 'platform:bank')
  const wallet = tb.rows.find((r) => r.account === 'user:1:wallet')
  assert.equal(bank.debit, 7500, 'the asset sits in the debit column')
  assert.equal(bank.credit, 0)
  assert.equal(wallet.credit, 5000, 'the liability sits in the credit column')
  assert.equal(wallet.debit, 0)

  assert.ok(!tb.rows.some((r) => r.account === 'platform:revenue'), 'untouched accounts are omitted')
})

test('createLedger requires a store', () => {
  assert.throws(() => createLedger({}), LedgerError)
})
