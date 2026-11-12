import type { Address, Hex } from 'viem'
import { arc, arcTestnet } from 'viem/chains'
import { getChain, getUsdc } from '@/onchain-facts'
import harness from './testnet-harness.json'

export type NetworkKey = 'arc-testnet' | 'arc'

export interface TokenInfo {
  symbol: string
  name: string
  address: Address
  decimals: number
  /** Coinbase Exchange product used ONLY for the reference chart (not an Arc pool price). */
  referenceProduct?: string
  /** Testnet-only token from the trading harness. It has no value and its price is set by a public test feed. */
  isTest?: boolean
  /** Public test price feed (testnet harness only). */
  testFeed?: Address
  /** Amount one call to the token's faucet hands out, in whole tokens. */
  faucetAmount?: string
}

/** Testnet-only stand-ins for the oracle and aggregator that Arc Testnet does not have. */
export interface TestHarness {
  router: Address
  usdcFeed: Address
}

export interface NetworkConfig {
  key: NetworkKey
  chainId: number
  label: string
  isTestnet: boolean
  /** Deployed ArcTradeOrders contract. Read from VITE_ORDERS_ADDRESS_* in .env. */
  ordersAddress?: Address
  /** Deployment transaction, used to find the first block to read logs from. */
  deployTxHash?: Hex
  quote: TokenInfo
  /** Tradable base tokens. A token is only tradable when the contract has an oracle feed for it. */
  bases: TokenInfo[]
  /** Present only on Arc Testnet. Replaces 0x for market swaps and Chainlink for prices, and says so in the UI. */
  testHarness?: TestHarness
  zeroEx: { supported: boolean; reason: string }
  oracle: { supported: boolean; reason: string }
  /**
   * Contracts a market swap may be sent to, and may be approved as spender. The backend's quote is
   * untrusted input: a transaction or allowance spender outside this list is rejected before the
   * wallet is asked to sign anything.
   */
  swapTargets: Address[]
}

const env = import.meta.env

/**
 * 0x AllowanceHolder. Deterministic address for Cancun chains; code is present at this address on
 * Arc mainnet. Confirm it against 0x's contract list before mainnet use.
 */
export const ZEROEX_ALLOWANCE_HOLDER: Address = '0x0000000000001fF3684f28c67538d4D072C22734'

/** KyberSwap MetaAggregationRouterV2. Code is present at this address on Arc mainnet; confirm it against KyberSwap's docs before mainnet use. */
export const KYBER_ROUTER: Address = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'

function addr(value: unknown): Address | undefined {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Address) : undefined
}

function usdcFor(chainId: number): TokenInfo {
  const fact = getUsdc(chainId)
  if (!fact) throw new Error(`USDC is missing from onchain facts for chain ${chainId}`)
  return { symbol: 'USDC', name: 'USD Coin', address: fact.address as Address, decimals: fact.decimals }
}

const testAssets: TokenInfo[] = harness.assets.map((a) => ({
  symbol: a.symbol,
  name: a.name,
  address: a.address as Address,
  decimals: a.decimals,
  referenceProduct: a.referenceProduct,
  isTest: true,
  testFeed: a.feed as Address,
  faucetAmount: a.faucetAmount,
}))

const TESTNET_ID = arcTestnet.id
const MAINNET_ID = arc.id

/**
 * Arc Testnet tokens come from https://docs.arc.io/arc/references/contract-addresses
 * (EURC, cirBTC, WETH). Mainnet base tokens are intentionally empty until the mainnet
 * configuration is confirmed: add them with their oracle feeds on the contract.
 */
export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  'arc-testnet': {
    key: 'arc-testnet',
    chainId: TESTNET_ID,
    label: 'Arc Testnet',
    isTestnet: true,
    ordersAddress: addr(env.VITE_ORDERS_ADDRESS_ARC_TESTNET),
    deployTxHash: env.VITE_ORDERS_DEPLOY_TX_ARC_TESTNET as Hex | undefined,
    quote: usdcFor(TESTNET_ID),
    testHarness: { router: harness.router as Address, usdcFeed: harness.usdcFeed as Address },
    bases: [
      ...testAssets,
      {
        symbol: 'EURC',
        name: 'Euro Coin',
        address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
        decimals: 6,
        referenceProduct: 'EURC-USDC',
      },
      {
        symbol: 'cirBTC',
        name: 'Circle Bitcoin',
        address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
        decimals: 8,
        referenceProduct: 'BTC-USD',
      },
      {
        symbol: 'WETH',
        name: 'Wrapped Ether',
        address: '0x2c4047028a72803939b6fb674D01bC059B5C4961',
        decimals: 18,
        referenceProduct: 'ETH-USD',
      },
    ],
    zeroEx: { supported: false, reason: '0x does not support Arc Testnet. Testnet swaps use the test router instead.' },
    oracle: { supported: false, reason: 'Chainlink Data Feeds are not deployed on Arc Testnet. Only the test assets have (public, settable) test feeds.' },
    swapTargets: [harness.router as Address],
  },
  arc: {
    key: 'arc',
    chainId: MAINNET_ID,
    label: 'Arc',
    isTestnet: false,
    ordersAddress: addr(env.VITE_ORDERS_ADDRESS_ARC_MAINNET),
    deployTxHash: env.VITE_ORDERS_DEPLOY_TX_ARC_MAINNET as Hex | undefined,
    quote: usdcFor(MAINNET_ID),
    bases: [],
    zeroEx: { supported: true, reason: '' },
    oracle: { supported: true, reason: '' },
    // Extra reviewed targets can be added with VITE_SWAP_TARGETS_ARC (comma-separated addresses).
    swapTargets: [ZEROEX_ALLOWANCE_HOLDER, KYBER_ROUTER, ...String(env.VITE_SWAP_TARGETS_ARC ?? '').split(',').map((s) => addr(s.trim())).filter((a): a is Address => Boolean(a))],
  },
}

export const NETWORK_LIST: NetworkConfig[] = [NETWORKS['arc-testnet'], NETWORKS.arc]

/**
 * Tokens the terminal can actually trade. On Arc Testnet only the harness assets have an oracle feed,
 * so the other listed tokens (EURC, cirBTC, WETH) are shown in the portfolio but not offered for trading.
 */
export function tradableBases(network: NetworkConfig): TokenInfo[] {
  return network.testHarness ? network.bases.filter((t) => t.isTest) : network.bases
}

export function networkByChainId(chainId: number | undefined): NetworkConfig | undefined {
  return NETWORK_LIST.find((n) => n.chainId === chainId)
}

export function explorerBase(chainId: number): string {
  return getChain(chainId)?.explorerBase ?? ''
}
