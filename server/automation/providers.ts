/**
 * Automation provider registry.
 *
 * ArcTradeOrders has no privileged executor: `execute`, `executeDca`, `activateStop`,
 * `pokeTrailing` and `expireOrder` can be called by anyone, and the caller earns the
 * on-chain keeper fee. A provider is anything that watches the contract and submits
 * those calls. This file records what was verified about each option on Arc, so the
 * UI never claims automation that does not exist.
 */
import { keeperStatus } from '../keeper'

export type ProviderState = 'active' | 'available' | 'unsupported' | 'unverified'

export interface ProviderInfo {
  id: string
  name: string
  state: ProviderState
  summary: string
  /** Where the claim comes from. Researched 2026-11-11. */
  evidence: string
}

export interface AutomationProvider {
  id: string
  /** Called on every tick by the host process. Providers submit permissionless contract calls. */
  start(): void
}

export function listProviders(): ProviderInfo[] {
  const keeper = keeperStatus()
  return [
    {
      id: 'local-keeper',
      name: 'Built-in keeper (this backend)',
      state: keeper.running ? 'active' : 'available',
      summary: keeper.running
        ? 'Running. Watches open orders and DCA plans and submits executions.'
        : 'Not running. Set KEEPER_ENABLED=true and KEEPER_PRIVATE_KEY on the backend to start it.',
      evidence: 'server/keeper.ts',
    },
    {
      id: 'third-party-keepers',
      name: 'Any third-party keeper',
      state: 'available',
      summary: 'Execution entry points are permissionless and pay a keeper fee, so independent bots can run them.',
      evidence: 'contracts/ArcTradeOrders.sol',
    },
    {
      id: 'chainlink-cre',
      name: 'Chainlink CRE',
      state: 'unverified',
      summary: 'Live on Arc Testnet only and tenant-dependent. Not on Arc mainnet. No adapter is built.',
      evidence: 'Chainlink CRE forwarder directory; Arc availability table',
    },
    {
      id: 'chainlink-automation',
      name: 'Chainlink Automation',
      state: 'unsupported',
      summary: 'No evidence of an Arc deployment.',
      evidence: 'docs.chain.link supported networks',
    },
    {
      id: 'gelato',
      name: 'Gelato Web3 Functions',
      state: 'unsupported',
      summary: 'Web3 Functions and Automate were shut down on 2026-03-31.',
      evidence: 'Thyme Flow migration guide for Gelato users',
    },
    {
      id: 'thyme-flow',
      name: 'Thyme Flow',
      state: 'unverified',
      summary: 'Gelato successor. Arc support is not confirmed; check `thyme chains list` before relying on it.',
      evidence: 'flow.thymelabs.io docs',
    },
  ]
}
