/**
 * Market swaps never touch the order contract, so nothing onchain labels them as this app's swaps.
 * The browser reports a transaction hash after it confirms; this module re-derives everything from the
 * chain itself, so a forged or wrong report can only fail verification, never write false data:
 *   - the transaction must have succeeded and been sent to a known swap contract;
 *   - the sold and bought amounts come from the sender's ERC-20 Transfer logs.
 */
import { decodeEventLog, erc20Abi, type Address, type Hex } from 'viem'
import type { Db } from './db'

export interface ReceiptLike {
  status: 'success' | 'reverted'
  blockNumber: bigint
  from: Address
  to: Address | null
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[]
}

export interface TxReader {
  getTransactionReceipt(hash: Hex): Promise<ReceiptLike | null>
  getBlockTime(blockNumber: bigint): Promise<number>
}

/**
 * Arc emits an ERC-20 style Transfer for the native gas fee from this pseudo-address (18-decimal value).
 * Observed on Arc Testnet; it is not a token the user swapped, so it is ignored.
 */
export const NATIVE_GAS_PSEUDO_TOKEN = '0xfffffffffffffffffffffffffffffffffffffffe'

export interface RecordedSwap {
  owner: string
  target: string
  sellToken: string
  sellAmount: bigint
  buyToken: string
  buyAmount: bigint
  blockNumber: bigint
}

export type SwapVerdict =
  | { ok: true; swap: RecordedSwap }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_A_SWAP_TARGET' | 'REVERTED' | 'UNRECOGNIZED_SWAP'; message: string }

/** Pure: derives the swap from a receipt. Exactly one token leaves the sender and one different token arrives. */
export function deriveSwap(receipt: ReceiptLike, allowedTargets: readonly string[]): SwapVerdict {
  if (!receipt.to || !allowedTargets.map((a) => a.toLowerCase()).includes(receipt.to.toLowerCase())) {
    return { ok: false, code: 'NOT_A_SWAP_TARGET', message: 'The transaction was not sent to a known swap contract.' }
  }
  if (receipt.status !== 'success') return { ok: false, code: 'REVERTED', message: 'The transaction reverted.' }
  const sender = receipt.from.toLowerCase()
  const out = new Map<string, bigint>()
  const inn = new Map<string, bigint>()
  for (const log of receipt.logs) {
    let decoded
    try {
      decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
    } catch {
      continue
    }
    if (decoded.eventName !== 'Transfer') continue
    const { from, to, value } = decoded.args
    const token = log.address.toLowerCase()
    if (token === NATIVE_GAS_PSEUDO_TOKEN) continue
    if (from.toLowerCase() === sender) out.set(token, (out.get(token) ?? 0n) + value)
    if (to.toLowerCase() === sender) inn.set(token, (inn.get(token) ?? 0n) + value)
  }
  // A swap that returns part of the input shows the sold token on both sides: net them out.
  for (const [token, got] of [...inn]) {
    const gave = out.get(token)
    if (gave === undefined) continue
    if (gave > got) {
      out.set(token, gave - got)
      inn.delete(token)
    } else if (gave === got) {
      out.delete(token)
      inn.delete(token)
    } else {
      inn.set(token, got - gave)
      out.delete(token)
    }
  }
  if (out.size !== 1 || inn.size !== 1) {
    return { ok: false, code: 'UNRECOGNIZED_SWAP', message: 'Could not identify exactly one token sold and one token bought.' }
  }
  const [sellToken, sellAmount] = [...out][0]
  const [buyToken, buyAmount] = [...inn][0]
  return { ok: true, swap: { owner: sender, target: receipt.to.toLowerCase(), sellToken, sellAmount, buyToken, buyAmount, blockNumber: receipt.blockNumber } }
}

export async function recordSwap(db: Db, reader: TxReader, args: { chainId: number; hash: Hex; allowedTargets: readonly string[] }): Promise<SwapVerdict> {
  const receipt = await reader.getTransactionReceipt(args.hash)
  if (!receipt) return { ok: false, code: 'NOT_FOUND', message: 'Transaction not found yet. Retry after it confirms.' }
  const verdict = deriveSwap(receipt, args.allowedTargets)
  if (!verdict.ok) return verdict
  const s = verdict.swap
  const time = await reader.getBlockTime(s.blockNumber)
  await db`insert into swaps (chain_id, tx_hash, owner, target, sell_token, sell_amount, buy_token, buy_amount, block_number, block_time)
    values (${args.chainId}, ${args.hash.toLowerCase()}, ${s.owner}, ${s.target}, ${s.sellToken}, ${s.sellAmount.toString()}, ${s.buyToken}, ${s.buyAmount.toString()}, ${Number(s.blockNumber)}, ${time})
    on conflict (chain_id, tx_hash) do nothing`
  return verdict
}
