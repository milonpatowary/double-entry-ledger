'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createLedger,
  createMemoryStore,
  createMongoStore,
  InsufficientFundsError,
  IdempotencyConflictError
} = require('../src/index')
const { createFakeMongo } = require('./fake-mongo')

/**
 * One contract, run against every store.
 *
 * The ledger's rules live above the storage layer, but the guarantees they rely
 * on — atomic claim of an idempotency key, a guarded balance move that cannot
 * be raced — are the store's job, and each store implements them differently.
 * A shared contract is the only way to know they agree.
 */
const IMPLEMENTATIONS = [
  ['memory', () => createMemoryStore()],
  ['mongo(fake)', () => createMongoStore({ db: createFakeMongo() })]
]

for (const [name, build] of IMPLEMENTATIONS) {
  async function fixture ({ walletFunds = 0 } = {}) {
    const store = build()
    let seq = 0
    const ledger = createLedger({
      store,
      now: () => new Date(Date.UTC(2026, 0, 1) + seq * 1000),
      generateId: () => `e${String(++seq).padStart(4, '0')}`
    })

    await ledger.createAccount({ id: 'bank', type: 'asset', currency: 'USD' })
    await ledger.createAccount({ id: 'wallet', type: 'liability', currency: 'USD' })
    await ledger.createAccount({ id: 'revenue', type: 'revenue', currency: 'USD' })

    if (walletFunds) {
      await ledger.post({
        postings: [{ account: 'bank', debit: walletFunds }, { account: 'wallet', credit: walletFunds }]
      })
    }
    return ledger
  }

  test(`${name}: a balanced entry moves both balances`, async () => {
    const ledger = await fixture()
    await ledger.post({
      postings: [{ account: 'bank', debit: 2500 }, { account: 'wallet', credit: 2500 }]
    })
    assert.equal((await ledger.balance('bank')).balance, 2500)
    assert.equal((await ledger.balance('wallet')).balance, 2500)
  })

  test(`${name}: duplicate accounts are refused`, async () => {
    const ledger = await fixture()
    await assert.rejects(
      ledger.createAccount({ id: 'bank', type: 'asset', currency: 'USD' }),
      /already exists/
    )
  })

  test(`${name}: an idempotency key applies an entry exactly once`, async () => {
    const ledger = await fixture()
    const a = await ledger.post({
      idempotencyKey: 'k1',
      postings: [{ account: 'bank', debit: 1000 }, { account: 'wallet', credit: 1000 }]
    })
    const b = await ledger.post({
      idempotencyKey: 'k1',
      postings: [{ account: 'bank', debit: 1000 }, { account: 'wallet', credit: 1000 }]
    })
    assert.equal(a.id, b.id)
    assert.equal((await ledger.balance('wallet')).balance, 1000, 'applied once')
  })

  test(`${name}: the same key with different money is a conflict`, async () => {
    const ledger = await fixture()
    await ledger.post({
      idempotencyKey: 'k1',
      postings: [{ account: 'bank', debit: 1000 }, { account: 'wallet', credit: 1000 }]
    })
    await assert.rejects(
      ledger.post({
        idempotencyKey: 'k1',
        postings: [{ account: 'bank', debit: 2000 }, { account: 'wallet', credit: 2000 }]
      }),
      IdempotencyConflictError
    )
    assert.equal((await ledger.balance('wallet')).balance, 1000)
  })

  test(`${name}: a guarded account cannot be overdrawn`, async () => {
    const ledger = await fixture({ walletFunds: 1000 })
    await assert.rejects(
      ledger.post({
        postings: [{ account: 'wallet', debit: 1001 }, { account: 'revenue', credit: 1001 }]
      }),
      InsufficientFundsError
    )
    assert.equal((await ledger.balance('wallet')).balance, 1000, 'unchanged')
    assert.equal((await ledger.balance('revenue')).balance, 0, 'the other side did not move either')
  })

  test(`${name}: a rejected overdraw leaves no entry behind`, async () => {
    const ledger = await fixture({ walletFunds: 1000 })
    const before = (await ledger.listEntries({ limit: 100 })).length
    await assert.rejects(
      ledger.post({
        postings: [{ account: 'wallet', debit: 5000 }, { account: 'revenue', credit: 5000 }]
      }),
      InsufficientFundsError
    )
    const after = await ledger.listEntries({ limit: 100 })
    assert.equal(after.length, before, 'no entry was written')
  })

  test(`${name}: concurrent withdrawals cannot exceed the balance`, async () => {
    const ledger = await fixture({ walletFunds: 3000 })
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        ledger.post({
          postings: [{ account: 'wallet', debit: 1000 }, { account: 'revenue', credit: 1000 }]
        })
      )
    )
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3)
    assert.equal((await ledger.balance('wallet')).balance, 0)
  })

  test(`${name}: reversal restores the balances and keeps both entries`, async () => {
    const ledger = await fixture()
    const original = await ledger.post({
      postings: [{ account: 'bank', debit: 4000 }, { account: 'wallet', credit: 4000 }]
    })
    await ledger.reverse(original.id)

    assert.equal((await ledger.balance('wallet')).balance, 0)
    assert.equal((await ledger.getEntry(original.id)).postings[0].debit, 4000, 'original intact')
    assert.equal((await ledger.listEntries({ limit: 100 })).length, 2)
  })

  test(`${name}: reconcile finds no drift, and detects injected drift`, async () => {
    const ledger = await fixture({ walletFunds: 2000 })
    assert.deepEqual((await ledger.reconcile()).drift, [])

    await ledger.store.replaceBalances([
      { account: 'wallet', balance: 9999, debits: 0, credits: 9999, currency: 'USD' }
    ])
    const drifted = await ledger.reconcile()
    assert.equal(drifted.drift.length, 1)
    assert.equal(drifted.drift[0].computed.balance, 2000)

    await ledger.reconcile({ repair: true })
    assert.deepEqual((await ledger.reconcile()).drift, [])
  })

  test(`${name}: entries stream in chronological order`, async () => {
    const ledger = await fixture()
    for (let i = 1; i <= 5; i++) {
      await ledger.post({
        postings: [{ account: 'bank', debit: i * 100 }, { account: 'wallet', credit: i * 100 }]
      })
    }
    const seen = []
    for await (const entry of ledger.store.streamEntries()) seen.push(entry.amount)
    assert.deepEqual(seen, [100, 200, 300, 400, 500])
  })

  test(`${name}: listEntries filters by account`, async () => {
    const ledger = await fixture({ walletFunds: 5000 })
    await ledger.post({
      postings: [{ account: 'wallet', debit: 500 }, { account: 'revenue', credit: 500 }]
    })

    const revenueEntries = await ledger.listEntries({ account: 'revenue' })
    assert.equal(revenueEntries.length, 1)
    assert.equal(revenueEntries[0].amount, 500)

    const walletEntries = await ledger.listEntries({ account: 'wallet' })
    assert.equal(walletEntries.length, 2, 'the deposit and the spend')
  })
}

test('the fake mongo enforces the unique index the store depends on', async () => {
  const db = createFakeMongo()
  const col = db.collection('entries')
  await col.createIndex({ idempotencyKey: 1 }, { unique: true })

  await col.insertOne({ _id: 'a', idempotencyKey: 'k' })
  await assert.rejects(
    col.insertOne({ _id: 'b', idempotencyKey: 'k' }),
    (err) => err.code === 11000
  )

  // Null keys must not collide — most entries have no idempotency key at all.
  await col.insertOne({ _id: 'c', idempotencyKey: null })
  await col.insertOne({ _id: 'd', idempotencyKey: null })
  assert.equal(col._size(), 3)
})

test('the fake mongo honours a $gte filter, which is how the guard works', async () => {
  const db = createFakeMongo()
  const col = db.collection('balances')
  await col.insertOne({ _id: 'wallet', balance: 1000 })

  const refused = await col.updateOne({ _id: 'wallet', balance: { $gte: 5000 } }, { $inc: { balance: -5000 } })
  assert.equal(refused.matchedCount, 0, 'the guard refuses')
  assert.equal((await col.findOne({ _id: 'wallet' })).balance, 1000, 'and nothing moved')

  const allowed = await col.updateOne({ _id: 'wallet', balance: { $gte: 400 } }, { $inc: { balance: -400 } })
  assert.equal(allowed.matchedCount, 1)
  assert.equal((await col.findOne({ _id: 'wallet' })).balance, 600)
})
