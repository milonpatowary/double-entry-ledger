'use strict'

/**
 * A customer wallet, start to finish.
 *
 *   node examples/wallet.js
 *
 * Runs entirely in memory — no database needed. Swap createMemoryStore for
 * createMongoStore({ db }) and nothing else changes.
 */

const { createLedger, createMemoryStore, formatMinorUnits } = require('../src/index')

async function main () {
  const ledger = createLedger({ store: createMemoryStore() })

  // The bank account is an asset: money you actually hold.
  // A customer wallet is a LIABILITY: their balance is money you owe them.
  // Getting that pairing right is what makes a deposit balance.
  await ledger.createAccount({ id: 'platform:bank', type: 'asset', currency: 'USD' })
  await ledger.createAccount({ id: 'platform:fees', type: 'revenue', currency: 'USD' })
  await ledger.createAccount({ id: 'user:alice:wallet', type: 'liability', currency: 'USD' })

  console.log('\n1. Alice deposits $50\n')
  await ledger.post({
    description: 'Card deposit',
    idempotencyKey: 'deposit-alice-001',
    postings: [
      { account: 'platform:bank', debit: 5000 },
      { account: 'user:alice:wallet', credit: 5000 }
    ]
  })
  await show(ledger)

  console.log('\n2. The same deposit is retried — the network hiccuped\n')
  await ledger.post({
    description: 'Card deposit',
    idempotencyKey: 'deposit-alice-001',
    postings: [
      { account: 'platform:bank', debit: 5000 },
      { account: 'user:alice:wallet', credit: 5000 }
    ]
  })
  await show(ledger)
  console.log('   Alice still has $50, not $100. The retry was recognised.')

  console.log('\n3. Alice spends $12.50, of which $1.25 is our fee\n')
  await ledger.post({
    description: 'Purchase',
    postings: [
      { account: 'user:alice:wallet', debit: 1250 },
      { account: 'platform:fees', credit: 125 },
      { account: 'platform:bank', credit: 1125 }
    ]
  })
  await show(ledger)

  console.log('\n4. Alice tries to spend $100 she does not have\n')
  try {
    await ledger.post({
      description: 'Too much',
      postings: [
        { account: 'user:alice:wallet', debit: 10000 },
        { account: 'platform:bank', credit: 10000 }
      ]
    })
  } catch (err) {
    console.log(`   Refused: ${err.code} — ${err.message}`)
  }

  console.log('\n5. The purchase is charged back, so we reverse it\n')
  const purchase = (await ledger.listEntries({ account: 'platform:fees' }))[0]
  await ledger.reverse(purchase.id, { description: 'Chargeback' })
  await show(ledger)
  console.log('   Both the purchase and its reversal remain in the ledger.')

  console.log('\n6. Trial balance\n')
  const tb = await ledger.trialBalance()
  for (const row of tb.rows) {
    console.log(
      `   ${row.account.padEnd(22)} ${String(row.debit).padStart(8)} ${String(row.credit).padStart(8)}`
    )
  }
  console.log(`   ${''.padEnd(22)} ${'—'.padStart(8)} ${'—'.padStart(8)}`)
  console.log(
    `   ${'TOTAL'.padEnd(22)} ${String(tb.totals.debits).padStart(8)} ${String(tb.totals.credits).padStart(8)}` +
      `   balanced: ${tb.balanced}`
  )

  console.log('\n7. Reconcile — recompute every balance from the entries\n')
  const report = await ledger.reconcile()
  console.log(`   entries: ${report.entries}   accounts: ${report.accounts}`)
  console.log(`   debits === credits: ${report.balanced}`)
  console.log(`   drift: ${report.drift.length === 0 ? 'none' : JSON.stringify(report.drift)}\n`)
}

async function show (ledger) {
  for (const id of ['platform:bank', 'platform:fees', 'user:alice:wallet']) {
    const b = await ledger.balance(id)
    console.log(`   ${id.padEnd(22)} ${formatMinorUnits(b.balance, b.currency).padStart(12)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
