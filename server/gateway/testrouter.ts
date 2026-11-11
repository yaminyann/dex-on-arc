/**
 * TESTNET ONLY. Exposes a deployed TestSwapRouter (contracts/testnet/TestSwapRouter.sol) as a quote
 * provider so the whole gateway and keeper path can be exercised on Arc Testnet, where neither 0x
 * nor KyberSwap exist. Prices come from the public test feeds, not from a market.
 */
import { encodeFunctionData, erc20Abi, type Address } from 'viem'
import type { GatewayQuote, GatewayRequest, ProviderResult, QuoteKind, QuoteProvider } from './types'

export const testRouterAbi = [
  { type: 'function', name: 'quote', stateMutability: 'view', inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'swapExactIn', stateMutability: 'nonpayable', inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const

export interface TestRouterReader {
  quote(router: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint>
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>
}

export function createTestRouterProvider(opts: { id: string; router: Address; chainId: number; reader: TestRouterReader }): QuoteProvider {
  const { id, router, chainId, reader } = opts
  return {
    id,
    configured: () => true,
    supports: (c) => c === chainId,
    async fetch(kind: QuoteKind, req: GatewayRequest): Promise<ProviderResult> {
      const sell = BigInt(req.sellAmount)
      let out: bigint
      try {
        out = await reader.quote(router, req.sellToken as Address, req.buyToken as Address, sell)
      } catch {
        // No feed for one side of the pair, or a stale feed: no route rather than an invented price.
        return { kind: 'no_liquidity' }
      }
      if (out === 0n) return { kind: 'no_liquidity' }
      let allowance: GatewayQuote['allowance'] = null
      const actual = await reader.allowance(req.sellToken as Address, req.taker as Address, router).catch(() => 0n)
      if (actual < sell) allowance = { spender: router, actual }
      return {
        kind: 'quote',
        quote: {
          provider: id,
          sellAmount: sell,
          buyAmount: out,
          minBuyAmount: (out * BigInt(10_000 - req.slippageBps)) / 10_000n,
          route: [{ from: req.sellToken, to: req.buyToken, source: `Test router (${id}, feed price, 0.10% fee)`, proportionBps: '10000' }],
          networkFeeNative: null,
          allowance,
          spender: router,
          transaction:
            kind === 'quote'
              ? { to: router, data: encodeFunctionData({ abi: testRouterAbi, functionName: 'swapExactIn', args: [req.sellToken as Address, req.buyToken as Address, sell] }), value: 0n, gas: null }
              : undefined,
        },
      }
    },
  }
}

export function viemTestRouterReader(client: {
  readContract: (args: never) => Promise<unknown>
}): TestRouterReader {
  return {
    quote: (router, tokenIn, tokenOut, amountIn) => client.readContract({ address: router, abi: testRouterAbi, functionName: 'quote', args: [tokenIn, tokenOut, amountIn] } as never) as Promise<bigint>,
    allowance: (token, owner, spender) => client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] } as never) as Promise<bigint>,
  }
}
