import { TokenBTC, TokenETH, TokenEURC, TokenUSDC } from '@web3icons/react'
import type { TokenInfo } from '@/trading/networks'

export function TokenBase({ token, size = 22 }: { token: Pick<TokenInfo, 'symbol'>; size?: number }) {
  switch (token.symbol) {
    case 'USDC':
      return <TokenUSDC variant="branded" size={size} />
    case 'EURC':
      return <TokenEURC variant="branded" size={size} />
    case 'cirBTC':
      return <TokenBTC variant="branded" size={size} />
    case 'WETH':
      return <TokenETH variant="branded" size={size} />
    default:
      return (
        <span className="grid place-items-center rounded-full bg-raised text-[10px] font-semibold text-mute" style={{ width: size, height: size }}>
          {token.symbol.slice(0, 2)}
        </span>
      )
  }
}
