# Admin guide: fees and owner controls

Two layers control the platform. Know which is which before changing anything.

| Layer | Who | Where | Can it touch user funds? |
| --- | --- | --- | --- |
| **Contract owner** | The wallet that owns `ArcTradeOrders` | The **Admin** page (a tab that only the owner sees) | No. The owner cannot withdraw escrow, cannot upgrade, cannot rescue. Config changes are timelocked and public |
| **Backend operator** | Whoever runs the server | Environment variables, `ADMIN_TOKEN`, Coolify | No. The backend never holds user funds. It can only refuse to quote, stop its keeper, or change the swap fee |

## Fees

| Fee | Applies to | Rate | Paid to | Who sets it | Can it go up? |
| --- | --- | --- | --- | --- | --- |
| **Keeper fee** | Orders and DCA fills (output token) | 0.10% at deployment | Whoever submits the execution (your keeper wallet if you run it) | Contract owner, Admin page | **No.** The contract only lets it be lowered |
| **Platform swap fee** | Market swaps made in the browser | 0 to 1.00% of the sell amount | `PLATFORM_FEE_RECIPIENT` | Backend env, `PLATFORM_FEE_BPS` | Yes, by redeploying the backend. Hard cap 100 bps in code |
| Network (gas) fee | Everything | Paid in USDC | The chain | n/a | n/a |

How the **platform swap fee** works: the backend asks the aggregator for a quote with the fee parameters (KyberSwap `feeAmount`, `chargeFeeBy=currency_in`, `feeReceiver`; 0x `swapFeeBps`, `swapFeeRecipient`, `swapFeeToken`). The router takes the fee out of the sell amount and pays the recipient **inside the same swap transaction**. The quote the user sees already has the fee deducted and the form shows a "Platform fee" row. The backend never holds the fee or the user's funds.

Limits to know:

- The swap fee is **not** charged on orders or DCA (the contract executes those through allowlisted routers with exact-spend checks). Platform revenue on orders is the keeper fee: run your own keeper and your keeper wallet earns it.
- It does not apply on Arc Testnet (the test routers do not charge fees). Test the fee on a mainnet **quote** only; do not trade to test it.
- A fee turned on by mistake is bounded: invalid settings turn the fee **off**, never on (`PLATFORM_FEE_BPS` above 100, a missing or zero recipient, a non-number).
- The fee recipient is chosen by the server, so a compromised backend could redirect it. Keep the recipient a multisig or cold wallet, and protect the server like a hot wallet that cannot lose user funds but can lose fee revenue.
- The 0x fee parameters are implemented but have not been run against a live 0x key; KyberSwap's have (a 0.30% fee cut the quoted output by 0.30% on a live mainnet quote).

To change the swap fee: edit `PLATFORM_FEE_BPS` / `PLATFORM_FEE_RECIPIENT` in Coolify and redeploy `api`. Check it under Admin -> Fees (the recipient shows once you enter the admin token).

## The Admin page

Connect the owner wallet. An **Admin** tab appears in the header. It is visible only to the owner (and to a wallet the owner has offered ownership to); anyone else sees nothing. This is convenience, not security: every action is a contract call that reverts for any other wallet.

### Contract controls

| Control | Effect | Timelock | Reversible |
| --- | --- | --- | --- |
| **Pause trading** | Stops new orders, DCA plans and executions. Cancel, refund, expiry and DCA pause/cancel keep working, so nobody is trapped | None | Yes: Resume |
| **Minimum order size** | Rejects new orders under the minimum (0 to 10,000 USDC). Keeps dust out so keepers are paid for gas | None | Yes |
| **Transfer ownership** | Two steps: you offer, the new owner accepts from their wallet. Until accepted you stay in control. `renounceOwnership` is disabled | None | Yes until accepted |

Moving ownership to a **multisig** is the first mainnet step: offer to the multisig address, then accept from the multisig.

### Fees

Shows both fees and lets the owner **lower the keeper fee** (permanent: the contract rejects any increase).

### Tokens, routers and queued changes

- **Tokens with a price feed**: the tokens orders and DCA can use. **Disable now** switches one off immediately (existing orders can still be refunded).
- **Allowed swap routers**: the contracts a keeper may swap through. **Disable now** revokes one immediately.
- **Queue a token feed** (token address, Chainlink-style feed address, max staleness in seconds, 60 to 172,800) and **Queue a swap router** (allow or revoke): each is queued, becomes applicable after the contract's delay (testnet 1 hour; use 48 hours or more on mainnet), and expires 14 days after it becomes ready.
- **Queued changes** lists every pending change with a countdown. **Apply** unlocks when the delay has passed; **Cancel** removes it. Everything queued is public onchain, so users can see it coming.
- **Recent owner actions** is the log of owner transactions with links to the explorer.

This list is rebuilt from the indexer and confirmed against the chain, so it needs `INDEXER_ENABLED=true`. Without it you can still queue changes; you just cannot see the list.

Rules of thumb:

- Allow only audited aggregator routers. **Never allow a token, or any contract that holds privileges over the orders contract, as a swap target.**
- Set a feed's staleness a little above its heartbeat (Chainlink feeds on Arc: 24 hours).
- Rehearse every change on testnet first.

### Backend status

Paste `ADMIN_TOKEN` and press Load. It is kept for this browser tab only and is sent only to your own backend. You see:

- **Keeper**: running or stopped, role, its wallet, executions, open orders and plans, time since the last tick, and its **gas balance** (warning under 1 USDC).
- **Quote providers**: each provider's circuit breaker. "Breaker open" means it has been failing and is skipped for a while.
- **Indexer**: running or off and how many blocks it lags behind the chain.

## What an admin can and cannot do

| Can | Cannot |
| --- | --- |
| Pause new trading | Take or freeze anyone's escrow, or block refunds |
| Lower the keeper fee, set a minimum order size | Raise the keeper fee |
| Queue tokens and routers (public, delayed) | Add a token or router instantly |
| Disable a token or router instantly | Upgrade the contract or change its code |
| Transfer ownership (two steps) | Renounce ownership |
| Change the swap fee by redeploying the backend (max 1%) | Charge a swap fee on orders |

## Admin checklist before going live

- [ ] Owner is a multisig; signers and recovery plan written down.
- [ ] Config delay is at least 48 hours.
- [ ] Keeper wallet is separate from the owner, funded, and its balance is monitored.
- [ ] `ADMIN_TOKEN` is long, random, stored only in Coolify and your password manager.
- [ ] `PLATFORM_FEE_RECIPIENT` is a wallet you control and tested with a small quote.
- [ ] `ALLOWED_ORIGINS` and `TRUSTED_PROXY_HOPS` are set for your proxy chain.
- [ ] You have done a pause and resume drill on testnet and know who can press the button.
