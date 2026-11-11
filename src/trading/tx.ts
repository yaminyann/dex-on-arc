import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain, useWriteContract } from 'wagmi'
import type { Abi, Address, Hex, TransactionReceipt } from 'viem'
import { buildTxExplorerUrl } from '@/onchain-facts'
import type { NetworkConfig } from './networks'

export function parseOnchainError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const m = raw.toLowerCase()
  if (m.includes('user rejected') || m.includes('user denied')) return 'Transaction cancelled.'
  if (m.includes('insufficient funds') || m.includes('exceeds balance')) return 'Insufficient balance for this transaction or its gas.'
  if (m.includes('stale')) return 'The oracle price is stale, so the contract refused the order.'
  if (m.includes('tokennotsupported')) return 'This token has no oracle feed on the contract yet.'
  if (m.includes('insufficientoutput')) return 'The swap could not meet your minimum output.'
  if (m.includes('nottriggered')) return 'The trigger condition is not met yet.'
  if (m.includes('invalidparameters')) return 'The contract rejected these parameters (check trigger prices against the current price).'
  if (m.includes('reverted')) return 'The transaction reverted. Check the values and try again.'
  if (m.includes('network') || m.includes('timeout') || m.includes('fetch')) return 'Network issue. Check your connection and retry.'
  return 'Something went wrong. Please try again.'
}

export type TxPhase = 'idle' | 'wallet' | 'confirming'

/**
 * Sends contract writes and raw transactions on the selected network:
 * switches the wallet chain first, waits for the receipt, and reports through toasts.
 */
export function useTx(network: NetworkConfig) {
  const { chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { sendTransactionAsync } = useSendTransaction()
  const client = usePublicClient({ chainId: network.chainId })
  const [phase, setPhase] = useState<TxPhase>('idle')

  const ensureChain = useCallback(async () => {
    if (chainId !== network.chainId) {
      await switchChainAsync({ chainId: network.chainId })
    }
  }, [chainId, network.chainId, switchChainAsync])

  const finish = useCallback(
    async (hash: Hex, label: string): Promise<TransactionReceipt> => {
      setPhase('confirming')
      const receipt = await client!.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('reverted')
      toast.success(`${label} confirmed`, {
        action: { label: 'View', onClick: () => window.open(buildTxExplorerUrl(network.chainId, hash), '_blank', 'noopener,noreferrer') },
      })
      return receipt
    },
    [client, network.chainId],
  )

  const write = useCallback(
    async (label: string, p: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) => {
      if (!isConnected) throw new Error('Connect a wallet first')
      try {
        setPhase('wallet')
        await ensureChain()
        const hash = await writeContractAsync({ ...p, chainId: network.chainId })
        return await finish(hash, label)
      } catch (e) {
        const msg = parseOnchainError(e)
        if (msg !== 'Transaction cancelled.') toast.error(`${label} failed`, { description: msg })
        throw e
      } finally {
        setPhase('idle')
      }
    },
    [isConnected, ensureChain, writeContractAsync, network.chainId, finish],
  )

  const send = useCallback(
    async (label: string, p: { to: Address; data: Hex; value?: bigint }) => {
      if (!isConnected) throw new Error('Connect a wallet first')
      try {
        setPhase('wallet')
        await ensureChain()
        const hash = await sendTransactionAsync({ to: p.to, data: p.data, value: p.value ?? 0n, chainId: network.chainId })
        return await finish(hash, label)
      } catch (e) {
        const msg = parseOnchainError(e)
        if (msg !== 'Transaction cancelled.') toast.error(`${label} failed`, { description: msg })
        throw e
      } finally {
        setPhase('idle')
      }
    },
    [isConnected, ensureChain, sendTransactionAsync, network.chainId, finish],
  )

  return { write, send, phase, busy: phase !== 'idle' }
}
