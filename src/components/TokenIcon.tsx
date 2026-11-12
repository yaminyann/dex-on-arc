import { TokenBTC, TokenETH, TokenEURC, TokenUSDC } from '@web3icons/react'
import type { TokenInfo } from '@/trading/networks'

export function TokenBase({ token, size = 22 }: { token: Pick<TokenInfo, 'symbol'> & { logoURI?: string }; size?: number }) {
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
      if ('logoURI' in token && token.logoURI) {
        return <img src={token.logoURI} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" className="rounded-full border border-line bg-raised" style={{ width: size, height: size }} onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
      }
      return (
        <span className="grid place-items-center border border-line bg-raised font-mono text-[10px] font-semibold" style={{ width: size, height: size }}>
          {token.symbol.slice(0, 2)}
        </span>
      )
  }
}
