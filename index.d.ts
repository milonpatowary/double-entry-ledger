/// <reference types="node" />

export type AccountType = 'asset' | 'expense' | 'liability' | 'equity' | 'revenue'
export type NormalBalance = 'debit' | 'credit'

export interface Account {
  id: string
  type: AccountType
  currency: string
  /** False means the balance is guarded and cannot go below zero. */
  allowNegative: boolean
  metadata: Record<string, unknown>
  createdAt: Date
}

/** Exactly one of `debit` or `credit`. Amounts are positive integer minor units. */
export type PostingInput =
  | { account: string, debit: number, credit?: never }
  | { account: string, credit: number, debit?: never }

/** As stored: both fields present, the unused one zero. */
export interface Posting {
  account: string
  debit: number
  credit: number
}

export interface Entry {
  id: string
  currency: string
  description: string
  metadata: Record<string, unknown>
  idempotencyKey: string | null
  /** Hash of the entry's financial content; how a retry is recognised. */
  fingerprint: string
  postings: Posting[]
  /** The entry's magnitude. Debits and credits are equal by definition. */
  amount: number
  /** Set on a reversing entry, naming the entry it reverses. */
  reverses: string | null
  createdAt: Date
}

export interface PostInput {
  postings: PostingInput[]
  description?: string
  /** Reuse to make a retry safe. Same key + same money returns the original entry. */
  idempotencyKey?: string | null
  metadata?: Record<string, unknown>
  /** Supply your own entry id; one is generated otherwise. */
  id?: string
}

export interface Balance {
  account: string
  currency: string
  balance: number
  debits: number
  credits: number
  /** Human-readable, for display only — never feed it back into arithmetic. */
  formatted: string
}

export interface DriftRow {
  account: string
  currency: string
  cached: { balance: number, debits: number, credits: number }
  computed: { balance: number, debits: number, credits: number }
  difference: number
}

export interface ReconcileReport {
  entries: number
  accounts: number
  /** Whether debits equal credits across every currency. */
  balanced: boolean
  totals: Record<string, { debits: number, credits: number }>
  drift: DriftRow[]
  repaired: number
}

export interface TrialBalanceRow {
  account: string
  type: AccountType
  currency: string
  debit: number
  credit: number
  formatted: string
}

export interface TrialBalance {
  rows: TrialBalanceRow[]
  totals: { debits: number, credits: number }
  balanced: boolean
}

export interface BalanceDelta {
  account: string
  currency: string
  /** Movement in the account's normal direction. */
  delta: number
  /** Non-null means the resulting balance must stay at or above `min`. */
  guard: { min: number } | null
}

/**
 * Storage behind the ledger.
 *
 * `commit` is the one method with a hard requirement: it must apply the entry
 * and the balance deltas atomically against concurrent callers, and reject with
 * InsufficientFundsError when a guard would be violated. Every guarantee the
 * ledger makes rests on it.
 */
export interface LedgerStore {
  name?: string
  createAccount (account: Account): Promise<Account>
  getAccount (id: string): Promise<Account | null>
  listAccounts (filter?: { currency?: string, type?: AccountType }): Promise<Account[]>

  getEntry (id: string): Promise<Entry | null>
  getEntryByIdempotencyKey (key: string): Promise<Entry | null>
  listEntries (filter?: { account?: string, limit?: number, after?: string | null }): Promise<Entry[]>
  streamEntries (): AsyncIterable<Entry>
  findReversalOf (entryId: string): Promise<Entry | null>
  markReversal (reversalId: string, originalId: string): Promise<void>

  commit (input: { entry: Entry, deltas: BalanceDelta[] }): Promise<Entry>

  getBalance (accountId: string): Promise<{ balance: number, debits: number, credits: number, currency: string } | null>
  replaceBalances (rows: Array<{ account: string, balance: number, debits: number, credits: number, currency: string }>): Promise<void>
  close? (): Promise<void>
}

export interface Ledger {
  createAccount (spec: {
    id: string
    type: AccountType
    currency: string
    /** Defaults to false for liabilities (guarded) and true for everything else. */
    allowNegative?: boolean
    metadata?: Record<string, unknown>
  }): Promise<Account>
  getAccount (id: string): Promise<Account | null>
  listAccounts (filter?: { currency?: string, type?: AccountType }): Promise<Account[]>

  post (input: PostInput): Promise<Entry>
  reverse (entryId: string, options?: {
    description?: string
    idempotencyKey?: string
    metadata?: Record<string, unknown>
  }): Promise<Entry>

  balance (accountId: string): Promise<Balance>
  getEntry (entryId: string): Promise<Entry | null>
  listEntries (filter?: { account?: string, limit?: number, after?: string | null }): Promise<Entry[]>

  reconcile (options?: { repair?: boolean }): Promise<ReconcileReport>
  trialBalance (options?: { currency?: string }): Promise<TrialBalance>

  store: LedgerStore
}

export declare function createLedger (options: {
  store: LedgerStore
  /** Injectable clock, so tests can be deterministic. */
  now?: () => Date
  generateId?: () => string
}): Ledger

export declare function createMemoryStore (): LedgerStore & {
  _counts (): { accounts: number, entries: number }
}

export declare function createMongoStore (options: {
  db: unknown
  /** Pass the MongoClient to enable transactional commits. See the README. */
  client?: unknown
  prefix?: string
  autoIndex?: boolean
}): LedgerStore & { ensureIndexes (): Promise<unknown>, readonly supportsTransactions: boolean | null }

export declare const ACCOUNT_TYPES: Record<AccountType, { normal: NormalBalance }>
export declare const TYPE_NAMES: AccountType[]

export declare function formatMinorUnits (minorUnits: number, currency: string): string
export declare function assertAmount (value: number, label?: string): number
export declare function assertCurrency (value: string): string
export declare function fingerprintOf (postings: Posting[], currency: string): string

export declare class LedgerError extends Error {
  code: string
}
export declare class UnbalancedEntryError extends LedgerError {
  debits: number
  credits: number
  currency: string
  difference: number
}
export declare class UnknownAccountError extends LedgerError { accountId: string }
export declare class CurrencyMismatchError extends LedgerError {
  expected: string
  found: string
  accountId: string
}
export declare class InsufficientFundsError extends LedgerError {
  accountId: string
  available: number
  requested: number
  currency: string
  shortfall: number
}
export declare class IdempotencyConflictError extends LedgerError { idempotencyKey: string }
export declare class ImmutableEntryError extends LedgerError {
  entryId: string
  action: string
}
