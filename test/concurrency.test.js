'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createLedger, createMemoryStore, InsufficientFundsError } = require('../src/index')

/**
 * The failures a ledger exists to prevent are concurrency failures.
 *
 * Sequential correctness is easy and every implementation has it. What
 * separates a ledger you can put money through from one you cannot is what
 * happens when two requests arrive at the same instant — and that is precisely
 * the case that never shows up in manual testing, because a human cannot click
 * twice in the same millisecond.
 */

async function walletWith (amount, { allowNegative = false } = {}) {
  const store = createMemoryStore()
  let seq = 0
  const ledger = createLedger({
    store,
    now: () => new Date(Date.UTC(2026, 0, 1) + seq * 1000),
    generateId: () => `e${String(++seq).padStart(4, '0')}`
  })

  await ledger.createAccount({ id: 'bank', type: 'asset', currency: 'USD' })
  await ledger.createAccount({ id: 'wallet', type: 'liability', currency: 'USD', allowNegative })
  await ledger.createAccount({ id: 'revenue', type: 'revenue', currency: 'USD' })

  if (amount > 0) {
    await ledger.post({
      postings: [{ account: 'bank', debit: amount }, { account: 'wallet', credit: amount }]
    })
  }
  return { ledger, store }
}

const spend = (amount, key) => ({
  ...(key ? { idempotencyKey: key } : {}),
  postings: [
    { account: 'wallet', debit: amount },
    { account: 'revenue', credit: amount }
  ]
})

test('ten concurrent withdrawals against five withdrawals of funds: exactly five succeed', async () => {
  const { ledger, store } = await walletWith(5000)

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => ledger.post(spend(1000)))
  )

  const ok = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')

  assert.equal(ok.length, 5, 'exactly five withdrawals of 1000 fit in 5000')
  assert.equal(rejected.length, 5)
  for (const r of rejected) {
    assert.ok(r.reason instanceof InsufficientFundsError, 'and the rest fail for the right reason')
  }

  assert.equal((await ledger.balance('wallet')).balance, 0, 'the wallet lands exactly on zero')
  assert.equal(store._counts().entries, 6, 'one deposit plus five withdrawals — no phantom entries')

  const report = await ledger.reconcile()
  assert.deepEqual(report.drift, [], 'and the cache still agrees with the entries')
})

test('a burst that cannot fit at all leaves the balance untouched', async () => {
  const { ledger, store } = await walletWith(500)

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => ledger.post(spend(1000)))
  )

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 0)
  assert.equal((await ledger.balance('wallet')).balance, 500)
  assert.equal(store._counts().entries, 1, 'only the original deposit')
})

test('concurrent posts sharing an idempotency key produce one entry', async () => {
  const { ledger, store } = await walletWith(5000)

  const results = await Promise.all(
    Array.from({ length: 12 }, () => ledger.post(spend(1000, 'withdrawal-1')))
  )

  const ids = new Set(results.map((r) => r.id))
  assert.equal(ids.size, 1, 'every caller got the same entry')
  assert.equal(store._counts().entries, 2, 'deposit plus one withdrawal')
  assert.equal((await ledger.balance('wallet')).balance, 4000, 'applied exactly once')
})

test('a mix of guarded and unguarded accounts still balances under load', async () => {
  const { ledger } = await walletWith(10000)

  await Promise.allSettled([
    ...Array.from({ length: 6 }, () => ledger.post(spend(1000))),
    ...Array.from({ length: 6 }, () =>
      ledger.post({
        postings: [{ account: 'bank', credit: 500 }, { account: 'revenue', debit: 500 }]
      })
    )
  ])

  const report = await ledger.reconcile()
  assert.equal(report.balanced, true, 'debits still equal credits overall')
  assert.deepEqual(report.drift, [])

  const tb = await ledger.trialBalance()
  assert.equal(tb.balanced, true)
})

test('an unguarded wallet takes every withdrawal and goes negative', async () => {
  const { ledger } = await walletWith(1000, { allowNegative: true })

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => ledger.post(spend(1000)))
  )

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5)
  assert.equal((await ledger.balance('wallet')).balance, -4000)

  // Going negative is allowed here, but it must still be *correct*.
  const report = await ledger.reconcile()
  assert.deepEqual(report.drift, [])
  assert.equal(report.balanced, true)
})

test('concurrent reversals of the same entry produce one reversal', async () => {
  const { ledger, store } = await walletWith(0)

  const original = await ledger.post({
    postings: [{ account: 'bank', debit: 5000 }, { account: 'wallet', credit: 5000 }]
  })

  const results = await Promise.all(Array.from({ length: 5 }, () => ledger.reverse(original.id)))

  assert.equal(new Set(results.map((r) => r.id)).size, 1)
  assert.equal(store._counts().entries, 2, 'the original and exactly one reversal')
  assert.equal((await ledger.balance('wallet')).balance, 0)
})

test('the ledger equation holds across a long random workload', async () => {
  const { ledger } = await walletWith(100000)

  // Deterministic pseudo-random, so a failure is reproducible.
  let seed = 12345
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }

  const work = []
  for (let i = 0; i < 200; i++) {
    const amount = (rnd(50) + 1) * 100
    work.push(
      rnd(2) === 0
        ? ledger.post(spend(amount))
        : ledger.post({
            postings: [{ account: 'bank', debit: amount }, { account: 'wallet', credit: amount }]
          })
    )
  }
  await Promise.allSettled(work)

  const report = await ledger.reconcile()
  assert.equal(report.balanced, true, 'debits equal credits after 200 interleaved operations')
  assert.deepEqual(report.drift, [], 'and no balance drifted from its entries')
  assert.ok((await ledger.balance('wallet')).balance >= 0, 'the guarded wallet never went negative')
})
