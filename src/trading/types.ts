import type { Address } from 'viem'

/** Mirrors the enums in contracts/ArcTradeOrders.sol. */
export const Side = { BUY: 0, SELL: 1 } as const
export const OrderType = { LIMIT: 0, STOP_LOSS: 1, TAKE_PROFIT: 2, STOP_LIMIT: 3, TRAILING_STOP: 4, OCO: 5 } as const
export const Status = { OPEN: 0, EXECUTED: 1, CANCELLED: 2, EXPIRED: 3 } as const
export const DcaStatus = { ACTIVE: 0, PAUSED: 1, CANCELLED: 2, COMPLETED: 3 } as const

export type OrderTypeValue = (typeof OrderType)[keyof typeof OrderType]

export const ORDER_TYPE_LABEL: Record<number, string> = {
  0: 'Limit',
  1: 'Stop-loss',
  2: 'Take-profit',
  3: 'Stop-limit',
  4: 'Trailing stop',
  5: 'OCO',
}

export const STATUS_LABEL: Record<number, string> = { 0: 'Open', 1: 'Executed', 2: 'Cancelled', 3: 'Expired' }
export const DCA_STATUS_LABEL: Record<number, string> = { 0: 'Active', 1: 'Paused', 2: 'Cancelled', 3: 'Completed' }

/** Reason codes returned by checkOrder. */
export const ORDER_REASON: Record<number, string> = {
  0: 'Ready to execute',
  1: 'Not open',
  2: 'Expired',
  3: 'Waiting for trigger',
  4: 'Oracle price unavailable',
  5: 'Contract paused',
}

/** Reason codes returned by checkDca. */
export const DCA_REASON: Record<number, string> = {
  0: 'Ready to execute',
  1: 'Not active',
  2: 'Next buy not due',
  3: 'Price above your cap',
  4: 'Oracle price unavailable',
  5: 'Contract paused',
}

export interface OrderView {
  id: bigint
  owner: Address
  side: number
  orderType: number
  status: number
  expiry: number
  stopActivated: boolean
  base: Address
  trailBps: number
  maxSlippageBps: number
  createdAt: number
  executedAt: number
  amountIn: bigint
  triggerPrice: bigint
  limitPrice: bigint
  peakPrice: bigint
  amountOut: bigint
  executionPrice: bigint
  /** Live readiness from checkOrder (open orders only). */
  reasonCode?: number
  livePrice?: bigint
}

export interface DcaView {
  id: bigint
  owner: Address
  status: number
  nextExecution: number
  interval: number
  base: Address
  maxSlippageBps: number
  executions: number
  createdAt: number
  amountPerBuy: bigint
  budgetRemaining: bigint
  maxPrice: bigint
  totalSpent: bigint
  totalBought: bigint
  reasonCode?: number
}

export const FREQUENCIES = [
  { id: 'hourly', label: 'Hourly', seconds: 3600 },
  { id: 'daily', label: 'Daily', seconds: 86400 },
  { id: 'weekly', label: 'Weekly', seconds: 604800 },
  { id: 'monthly', label: 'Monthly (30d)', seconds: 2592000 },
] as const
