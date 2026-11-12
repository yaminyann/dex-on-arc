# Live testnet test report (Arc Testnet, order contract v2)

Campaign of 2026-11-11 and 2026-11-12 (UTC), run against the unaudited v2 `ArcTradeOrders` at `0xa83efe842010dbd470dfe7cc210d61c4edd908aa` on Arc Testnet (chain 5042002). Nothing was sent to mainnet. All hashes below are public testnet transactions; click through to verify. Raw data: [e2e-full.json](e2e-full.json), [e2e-security.json](e2e-security.json), and the earlier runs [e2e-main.json](e2e-main.json), [e2e-rerun.json](e2e-rerun.json), [e2e-rerun2.json](e2e-rerun2.json).

## Result

After the testnet wallets were funded, the final runs passed completely:

- **Full end-to-end run: 14/14 scenarios** (limit, stop-loss, take-profit, trailing stop, OCO, stop-limit, cancel, expiry, DCA, market swap, minimum order size, paged views, three-order batch).
- **Security and failure-handling suite: 8/8 scenarios** (access control, timelock, fee and minimum-size bounds, ownership, pause, oracle protection, router allowlist and hostile calldata, router disable with keeper failover).

The earlier runs on the same day had failures. They are kept below as history because the failures led to real fixes (see "Defects found"): two keeper defects, one missing resilience feature, and one contract size problem, plus test-environment limits (the test routers pay sells from their own USDC and ran out until the wallets were funded).

## What was verified, against what you asked for

| Requirement | Status | Evidence |
| --- | --- | --- |
| DCA execution | **Verified live** | Create [`0x61bf344e…2a3a`](https://explorer.testnet.arc.io/tx/0x61bf344ef0024bee377a3eca5c18b0f4a52e69c5cebdfffee7a454ef6ff92a3a), pause [`0x1d6acedb…42f1`](https://explorer.testnet.arc.io/tx/0x1d6acedbd083722969a7642f49259f53c2377f366890345345dde46c55da42f1), resume [`0x9a2be39b…5cdc`](https://explorer.testnet.arc.io/tx/0x9a2be39bbe9bacd718160ef366cfe24d4cc2571c01f5bfff31ab86267b645cdc), keeper buy (DcaExecuted id 3, [`0xe5677c57…b7de`](https://explorer.testnet.arc.io/tx/0xe5677c5726037ce9ed592426bcac324da83e0a73b343ce34bf08ce0e8c82b7de)), cancel with refund of the rest [`0xb2b9db07…1541`](https://explorer.testnet.arc.io/tx/0xb2b9db07ba13ae90216006ad37eb5265c9f6eb386211be6c50e36ba60ded1541) |
| Stop-loss execution | **Verified live** | Keeper fill, OrderExecuted id 56, [`0xb7991c48…495a`](https://explorer.testnet.arc.io/tx/0xb7991c48863b1e6ddd560f5961ce192b8bff05c2f3418c44fd7353d6d90d495a) |
| Take-profit execution | **Verified live** | Keeper fill, OrderExecuted id 57, [`0x0abecca7…1cee`](https://explorer.testnet.arc.io/tx/0x0abecca7ed53d29b7b3e7d9668670ec879b90618903f665e795c7cc3b0281cee) |
| Other order types | **Verified live** | Limit sell id 55 [`0x65f6dafa…d274`](https://explorer.testnet.arc.io/tx/0x65f6dafab4f39898c76218685ead939c7bf85ecd7eb25466471ca8bf1656d274); trailing stop id 58 (peak recorded, then sold on reversal) [`0xebddbeaf…74d2`](https://explorer.testnet.arc.io/tx/0xebddbeafcf678fd5c9069240bacdaa74238b79aaf9c31b84ffeeaf9a352174d2); OCO id 59 [`0x910d904c…ff0a`](https://explorer.testnet.arc.io/tx/0x910d904c42fe256fe37def6b5abb475caf5efb4201d51293732fc7fff5e0ff0a); stop-limit id 60 (activated [`0x261389af…f268`](https://explorer.testnet.arc.io/tx/0x261389af3f284e980ffa7d5b63d0c4e0ba7320acd6bf17bcdee507f6ec4bf268), no fill below the limit, filled after the rebound [`0xe74b6f05…862e`](https://explorer.testnet.arc.io/tx/0xe74b6f0568ea764f459b3a6fd1a7ca2d1f241cb570cc59335f6ed8b826ff862e)) |
| Batch execution, multiple orders | **Verified live (three orders in one transaction)** | One keeper `executeMany` (selector `0x9c96f007`, status success) [`0x31081092…57e1`](https://explorer.testnet.arc.io/tx/0x31081092cee134dfebe26b864a1fbea9084efe0875cd860f48749441052757e1) executed orders 63, 64 and 65. Earlier runs: [`0x269ecbc8…7bc5`](https://explorer.testnet.arc.io/tx/0x269ecbc893644edcf18705c6d2c4e6df9994422a49294b1dc93d80d8b8647bc5) (two orders) and [`0x3d70d02a…53d6`](https://explorer.testnet.arc.io/tx/0x3d70d02ad5fd9c5a231ea90c198764dffe9f6b6d61f34639cb8c29f23f2853d6) (two executed, one skipped with `BatchItemFailed`, which shows per-item isolation) |
| Router allowlist validation | **Verified live** | Six hostile executions against an open order were each rejected (random address, a token, the orders contract, half the input = `PartialFill`, output in a different token, garbage calldata); the order stayed OPEN, the escrow and the allowance to the router were untouched. The honest execution through allowlisted router B then succeeded, paid the owner 0.119761 USDC and left no standing approval: [`0x7029402a…a841`](https://explorer.testnet.arc.io/tx/0x7029402a3830eafdc4760d96f6ca69760edcc3794579ff4b98c36c68dda3a841) |
| Router failure handling and failover | **Verified live** | The owner disabled router A instantly [`0xe65e00b8…310d`](https://explorer.testnet.arc.io/tx/0xe65e00b81b21a560fca3e6c7c9d9bb057374eadbe78a2e253fa1c7adc9a5310d); an outsider could not; router A then rejected even correct calldata; a fresh order was filled by the keeper through router B [`0xc093d15e…5bb6`](https://explorer.testnet.arc.io/tx/0xc093d15e9d1ae9505982a4db4009cd7af48a98b4cedb1c977cd7e1108d9e5bb6) (receipt has logs from router B and none from router A). Earlier, with router A allowlisted but empty, the keeper's simulation of A failed and it used B on its own (`providerFallbacks: 2`; [`0x5c67a9df…f800`](https://explorer.testnet.arc.io/tx/0x5c67a9dff71e2cb2c159ecbb7de07750c8b2e304e8649ad40d219fb04f6bf800), [`0x1f891b69…bb6b`](https://explorer.testnet.arc.io/tx/0x1f891b69b1f50ac1ef8a87356423d2af527d13dc88ccbb37c5607b5b6805bb6b)). Re-enabling router A is queued behind the timelock [`0x0df76b7d…1d63`](https://explorer.testnet.arc.io/tx/0x0df76b7d21df575ad0020e40299a0f6a942c71321a7d3b5b6dc71fb376371d63) |
| Oracle stale price protection | **Verified live** | Stale (2 min old against a 60 s limit), future-dated, zero, negative and reverting feeds were each rejected on `createOrder` and `execute`; `checkOrder` reported reason 4 (oracle unavailable) for each. Transactions in the "oracle" scenario below |
| Invalid round protection | **Verified live** | `answeredInRound < roundId` rejected as `StalePrice` (v2 addition), same scenario |
| Order cancellation and fund recovery | **Verified live** | Cancel with refund [`0x62a7b138…9d0c`](https://explorer.testnet.arc.io/tx/0x62a7b1385c06dc24523ba2a0495e1c422191b008bfa0ccf4778b8ad2f06c9d0c); expiry refunded by the keeper (OrderExpired id 62, [`0xba46a441…ad6b`](https://explorer.testnet.arc.io/tx/0xba46a441e3da97679e19ad62c986c383712a753b7563148259ff290890b1ad6b)); DCA cancel refunded the remaining budget; **cancel while the oracle is dead** [`0xe6a829c5…936c`](https://explorer.testnet.arc.io/tx/0xe6a829c5454c150da9b22a01972e7e606c34970c07e7126cc40d88f482ad936c) and **cancel while the contract is paused** [`0xf7260377…1850`](https://explorer.testnet.arc.io/tx/0xf7260377f19890fe3b831196c42f34d6499ce71ed85dd97e38760c19d30b1850) both refunded in full |
| Timelock configuration | **Verified live** | Delay is exactly 3,600 s from the queue block; `ConfigQueued` carries subject and flags; early `applyConfig` reverts `ConfigNotReady`; `cancelConfig` [`0x5cce1a78…d820`](https://explorer.testnet.arc.io/tx/0x5cce1a78dfd8f5c5b670393475b751db32743613b33e73b00e61b00e4370d820) clears the entry; applying a cancelled change reverts `ConfigUnknown`. The v2 feed and router configs were applied only after their delay |
| Access control | **Verified live** | Eleven admin functions rejected a non-owner with `OwnableUnauthorizedAccount`; renounce reverts `RenounceDisabled`; a pending ownership transfer does not change the owner; keeper fee cannot be raised; minimum order size is bounded; pause blocks creation and execution but not cancel or refund |

## What this campaign does not prove

- **It ran on test infrastructure.** Prices come from public test feeds and swaps go through test routers, not Chainlink feeds or real aggregators. Real aggregator calldata surviving the contract's checks on Arc mainnet is still unproven (the fork script needs Arc's Foundry fork).
- **The contract is unaudited**, and the owner on testnet is a single key.
- **Router A is disabled right now.** The failover scenario disabled it and queued the re-enable ([`0x0df76b7d…1d63`](https://explorer.testnet.arc.io/tx/0x0df76b7d21df575ad0020e40299a0f6a942c71321a7d3b5b6dc71fb376371d63)); `bun run server/testnet/apply-config.ts` applies it once the one-hour delay has passed.
- Mainnet gas economics, Chainlink's 24-hour heartbeat, and multi-keeper behaviour under load were not part of this campaign. See [../mainnet-readiness-checklist.md](../mainnet-readiness-checklist.md).

## Defects found by the campaign (all fixed)

| Defect | How it showed | Fix |
| --- | --- | --- |
| Keeper and test script shared one key, so the keeper's explicit nonces raced the script's transactions | Random `setPrice`/`createOrder` reverts in the first runs | The keeper has its own key in `.env`. In production the keeper key must never be shared |
| Retry backoff grew to 10 minutes | Stop-limit fill timed out after a brief unfillable window | Defaults 5 s base, 60 s cap (`KEEPER_BACKOFF_BASE_MS`, `KEEPER_BACKOFF_MAX_MS`) |
| If the best-ranked provider failed simulation the keeper never tried the next one | Orders stuck while the other router could fill | The keeper simulates every allowlisted quote best-first and uses the first that succeeds (metric `providerFallbacks`), confirmed live |
| v2 contract was 24,800 bytes, over the 24,576 limit | Testnet deployment failed at gas estimation | Trimmed to 23,778 bytes; CI runs `forge build --sizes` |
| Arc gas-fee `Transfer` log from `0xff…fe` broke swap verification | First live swap report was rejected | Ignored in `deriveSwap` |

## Environment notes

- The test routers pay sells from their own USDC. Stale open orders from earlier runs, owned by lost throwaway wallets, were executed by the keeper and drained that liquidity, which caused the earlier failures. The final runs started from a clean state with both routers funded with 4 USDC.
- Wallet keys for the later runs are derived from the deployer key and a seed printed in the log, so leftover funds are recoverable (each run sweeps its trader's USDC back to the deployer). Earlier runs used random keys; roughly 4 testnet USDC in those wallets is unrecoverable.
- One earlier run was disturbed by the machine sleeping (DNS failure); that run's failures were not counted.

## Raw results

### Final full end-to-end run

Run at 2026-11-12T07:30:52.492Z, order contract `0xa83efe842010dbd470dfe7cc210d61c4edd908aa`, trader `0x64644EA1B5a298E7d2934aF26BA8E92fdA04b3A0`. Result: **14/14 scenarios passed**. Run with `E2E_BATCH_N=3` and default sizes.

| Scenario | Result | Time | Detail |
| --- | --- | --- | --- |
| oracle reads test feeds through the order contract | PASS | 6s | tBTC $90091.38, tETH $2831.38, tSOL $73.31 |
| limit sell fills through keeper after price rises | PASS | 12s | received 0.461455 USDC at execution price 93507.59999999999 |
| stop-loss sells on a drop | PASS | 12s | filled at 2599.661111111111 |
| take-profit sells on a rise | PASS | 12s | filled at 78.28175 |
| trailing stop records the peak then sells on reversal | PASS | 15s | peak 100902.34174577, filled at 90630.4 |
| OCO: take-profit leg fires once and the order cannot run again | PASS | 12s | executed once; further execution reports "not open" |
| stop-limit: activation persists, no fill below the limit, fills after a rebound | PASS | 33s | activated, held unfilled below limit, filled at 69.1365 after rebound |
| cancel refunds the escrow | PASS | 4s | escrow taken then fully refunded |
| expired order is refunded by a keeper | PASS | 50s | expired and refunded |
| DCA buys on schedule, then pause, resume and cancel refund the rest | PASS | 8s | 1 buy executed (0.4 USDC), the remaining budget was refunded |
| market swap through the test router (what the UI sends) | PASS | 2s | 0.3 USDC bought 0.000105849380149483 tETH |
| v2: an order below the minimum size is rejected | PASS | 1s | 0.05 USDC rejected (minimum 0.1) |
| v2: paged views agree with the full id list | PASS | 1s | 8 orders, page of 3 matches |
| v2: a keeper batches several ready orders into one executeMany transaction | PASS | 13s | 3 orders executed in 1 transaction(s), 3 in a single executeMany |

Transactions per scenario:

- **limit sell fills through keeper after price rises** (PASS)
  - sent: createOrder [`0xa4815415…30f1`](https://explorer.testnet.arc.io/tx/0xa4815415b02a0175f10e4fb4afcbc095b547614bf6ccc9351d74f326c94d30f1), setPrice [`0x550f76cd…f2d3`](https://explorer.testnet.arc.io/tx/0x550f76cdab496e254ddc442f01a9984c4e755d8b580ad50db0f97f063a1df2d3), setPrice [`0x0880cb75…4645`](https://explorer.testnet.arc.io/tx/0x0880cb75c4b31cfd411e273de429af9cc673e2910487abc2c1191453fc564645)
  - on-chain events (keeper transactions): OrderExecuted#55 [`0x65f6dafa…d274`](https://explorer.testnet.arc.io/tx/0x65f6dafab4f39898c76218685ead939c7bf85ecd7eb25466471ca8bf1656d274)
- **stop-loss sells on a drop** (PASS)
  - sent: createOrder [`0x18e77c43…c17f`](https://explorer.testnet.arc.io/tx/0x18e77c43ac55c3ace9ad7549e6cf1818b8521b30ed7001c2c374d0fb9bb9c17f), setPrice [`0x03397993…cdec`](https://explorer.testnet.arc.io/tx/0x03397993f2fa5b4048b8062d90acfa19768e74162463c88e819a4e82e276cdec), setPrice [`0x4c408283…b332`](https://explorer.testnet.arc.io/tx/0x4c4082837f7220a75e31248a16ef8c2d0913257df171de33d6e20474601fb332)
  - on-chain events (keeper transactions): OrderExecuted#56 [`0xb7991c48…495a`](https://explorer.testnet.arc.io/tx/0xb7991c48863b1e6ddd560f5961ce192b8bff05c2f3418c44fd7353d6d90d495a)
- **take-profit sells on a rise** (PASS)
  - sent: createOrder [`0x14506991…9ddd`](https://explorer.testnet.arc.io/tx/0x145069913ae8c5dda59d75c5ff3391f669b0808c4d65a7191768c2fb7fab9ddd), setPrice [`0x865ef259…7566`](https://explorer.testnet.arc.io/tx/0x865ef2590fc228ed506bb6931fc689fe2277326a114cb0cc626f01117b5f7566), setPrice [`0xb45bac7b…c3cd`](https://explorer.testnet.arc.io/tx/0xb45bac7bf6cb0af8744b5439039d9608b5ed359a00d045f310dc4d41d637c3cd)
  - on-chain events (keeper transactions): OrderExecuted#57 [`0x0abecca7…1cee`](https://explorer.testnet.arc.io/tx/0x0abecca7ed53d29b7b3e7d9668670ec879b90618903f665e795c7cc3b0281cee)
- **trailing stop records the peak then sells on reversal** (PASS)
  - sent: createOrder [`0xd4e490f9…8317`](https://explorer.testnet.arc.io/tx/0xd4e490f9440ff73bf597d52e4b830c96e5928552c370c95142e91996a5348317), setPrice [`0x3a5db865…8176`](https://explorer.testnet.arc.io/tx/0x3a5db865f1bcb5bf642f5cecd644a042ef29d88fadfcd4b9c807b54307aa8176), setPrice [`0xd64dac2b…b4a8`](https://explorer.testnet.arc.io/tx/0xd64dac2b79ef580dd0303f69ae13669592c22c2c41178e5a16d7d017220ab4a8), setPrice [`0xb015e384…332b`](https://explorer.testnet.arc.io/tx/0xb015e3847698efdf4ecd17067a613862eba2119c49171e8c7c8dfa111fae332b)
  - on-chain events (keeper transactions): TrailingPeakUpdated#58 [`0x15718746…7280`](https://explorer.testnet.arc.io/tx/0x15718746a9b59217c8122b6a49338a89e8abf1aa463b96a44f0a4a968fe57280), OrderExecuted#58 [`0xebddbeaf…74d2`](https://explorer.testnet.arc.io/tx/0xebddbeafcf678fd5c9069240bacdaa74238b79aaf9c31b84ffeeaf9a352174d2)
- **OCO: take-profit leg fires once and the order cannot run again** (PASS)
  - sent: createOrder [`0x8a05f8da…24c8`](https://explorer.testnet.arc.io/tx/0x8a05f8da34f84680aa5171f6ce0418b509f7d6a35082449e1daadc3294f624c8), setPrice [`0xe2b9e4c8…b610`](https://explorer.testnet.arc.io/tx/0xe2b9e4c88497de9d047ef452351f8ae0dcbfefca0925fc44613a742598bbb610), setPrice [`0xf32b805b…9678`](https://explorer.testnet.arc.io/tx/0xf32b805b7e54fcfc675ffcc47871e4cd44a9028a94bc814b65d4a1469ef59678)
  - on-chain events (keeper transactions): OrderExecuted#59 [`0x910d904c…ff0a`](https://explorer.testnet.arc.io/tx/0x910d904c42fe256fe37def6b5abb475caf5efb4201d51293732fc7fff5e0ff0a)
- **stop-limit: activation persists, no fill below the limit, fills after a rebound** (PASS)
  - sent: createOrder [`0x635134a9…8d37`](https://explorer.testnet.arc.io/tx/0x635134a9ef104c57398e5be265833e4a25b99bcde87e10e3bb50607ab1898d37), setPrice [`0xe4a78a87…c584`](https://explorer.testnet.arc.io/tx/0xe4a78a8732923844bda9f9caa40726786c550ce3bf7f826e3a85a4299112c584), setPrice [`0xb8527756…42e7`](https://explorer.testnet.arc.io/tx/0xb85277567490c6a19227efdadcc3cd513e2dc7d937759e30b26083087ac642e7), setPrice [`0xeaf0d470…f462`](https://explorer.testnet.arc.io/tx/0xeaf0d4705a1d12b41081d1db52907946b80c271b0cac6d493b5869b79573f462)
  - on-chain events (keeper transactions): StopActivated#60 [`0x261389af…f268`](https://explorer.testnet.arc.io/tx/0x261389af3f284e980ffa7d5b63d0c4e0ba7320acd6bf17bcdee507f6ec4bf268), OrderExecuted#60 [`0xe74b6f05…862e`](https://explorer.testnet.arc.io/tx/0xe74b6f0568ea764f459b3a6fd1a7ca2d1f241cb570cc59335f6ed8b826ff862e)
- **cancel refunds the escrow** (PASS)
  - sent: createOrder [`0xe84f4819…f298`](https://explorer.testnet.arc.io/tx/0xe84f48192390afe41d4bc890da76b0ec9129c0f1ec3f597d6dca31d1906ef298), cancelOrder [`0x62a7b138…9d0c`](https://explorer.testnet.arc.io/tx/0x62a7b1385c06dc24523ba2a0495e1c422191b008bfa0ccf4778b8ad2f06c9d0c)
- **expired order is refunded by a keeper** (PASS)
  - sent: createOrder [`0xde4bf32d…1841`](https://explorer.testnet.arc.io/tx/0xde4bf32d6d222bfd5a56188353c7be99c4dce0f4f1cbdf58439a30dc5dba1841)
  - on-chain events (keeper transactions): OrderExpired#62 [`0xba46a441…ad6b`](https://explorer.testnet.arc.io/tx/0xba46a441e3da97679e19ad62c986c383712a753b7563148259ff290890b1ad6b)
- **DCA buys on schedule, then pause, resume and cancel refund the rest** (PASS)
  - sent: createDca [`0x61bf344e…2a3a`](https://explorer.testnet.arc.io/tx/0x61bf344ef0024bee377a3eca5c18b0f4a52e69c5cebdfffee7a454ef6ff92a3a), pauseDca [`0x1d6acedb…42f1`](https://explorer.testnet.arc.io/tx/0x1d6acedbd083722969a7642f49259f53c2377f366890345345dde46c55da42f1), resumeDca [`0x9a2be39b…5cdc`](https://explorer.testnet.arc.io/tx/0x9a2be39bbe9bacd718160ef366cfe24d4cc2571c01f5bfff31ab86267b645cdc), cancelDca [`0xb2b9db07…1541`](https://explorer.testnet.arc.io/tx/0xb2b9db07ba13ae90216006ad37eb5265c9f6eb386211be6c50e36ba60ded1541)
  - on-chain events (keeper transactions): DcaExecuted#3 [`0xe5677c57…b7de`](https://explorer.testnet.arc.io/tx/0xe5677c5726037ce9ed592426bcac324da83e0a73b343ce34bf08ce0e8c82b7de)
- **market swap through the test router (what the UI sends)** (PASS)
  - sent: approve [`0x677360b3…64ef`](https://explorer.testnet.arc.io/tx/0x677360b38bd12d81507b4d2742ac84bd9f76486aa723b0626d3e356e31a864ef), swapExactIn [`0x2447479d…0bf5`](https://explorer.testnet.arc.io/tx/0x2447479dc03ea8c6dac21d20e557a507d9176042dc1f9815a2e05b59af8f0bf5)
- **v2: a keeper batches several ready orders into one executeMany transaction** (PASS)
  - sent: createOrder [`0xc900231f…1227`](https://explorer.testnet.arc.io/tx/0xc900231f23c8a46501540690a4c04a111c1b66cdae127b4bb8d18971c9651227), createOrder [`0xddc89db3…0ea7`](https://explorer.testnet.arc.io/tx/0xddc89db30f737058c475c876c12546cb700e050f4a8770ca861b29d666b20ea7), createOrder [`0xca242861…135d`](https://explorer.testnet.arc.io/tx/0xca24286134f3e31e3239966f9867a5dba8e40dc5b650bf8c564e4c5a8ab9135d), setPrice [`0xb3ca8e1f…882b`](https://explorer.testnet.arc.io/tx/0xb3ca8e1f3791c27f888dc20f8dc6c450cb0bf6e73e505c43db5df974289e882b)
  - on-chain events (keeper transactions): OrderExecuted#63 [`0x31081092…57e1`](https://explorer.testnet.arc.io/tx/0x31081092cee134dfebe26b864a1fbea9084efe0875cd860f48749441052757e1), OrderExecuted#64 [`0x31081092…57e1`](https://explorer.testnet.arc.io/tx/0x31081092cee134dfebe26b864a1fbea9084efe0875cd860f48749441052757e1), OrderExecuted#65 [`0x31081092…57e1`](https://explorer.testnet.arc.io/tx/0x31081092cee134dfebe26b864a1fbea9084efe0875cd860f48749441052757e1)

### Final security and failure-handling suite

Run at 2026-11-12T07:32:52.727Z, order contract `0xa83efe842010dbd470dfe7cc210d61c4edd908aa`, trader `0x77DE392AE50e0a2FbE79E68A12476b91a539dcB6`. Result: **8/8 scenarios passed**.

| Scenario | Result | Time | Detail |
| --- | --- | --- | --- |
| access control: a non-owner cannot call any admin function | PASS | 2s | 11 admin functions all rejected the outsider: queueTokenConfig, queueSwapTarget, applyConfig, cancelConfig, disableToken, disableSwapTarget, setKeeperFeeBps, setMinOrderQuote, pause, unpause, transferOwnership |
| timelock: a queued change cannot be applied early, is fully visible, and can be cancelled | PASS | 8s | eta = queue time + 3600s; ConfigQueued carries subject/flags; early apply -> ConfigNotReady; cancel clears it; later apply -> ConfigUnknown |
| keeper fee can only be lowered; minimum order size is bounded | PASS | 1s | raise fee 10 -> 11; min order 10,001 USDC rejected |
| ownership: renounce is disabled and a pending transfer does not change the owner | PASS | 6s | renounce -> RenounceDisabled; transferOwnership only sets pendingOwner; an outsider cannot accept; pending cleared |
| pause: blocks new orders and execution but never blocks cancel and refund | PASS | 8s | create and execute rejected while paused; cancel refunded 0.0012 tORC in full; unpaused |
| oracle: stale, future-dated, mismatched-round, non-positive and reverting feeds are all rejected; funds stay recoverable | PASS | 22s | 6 bad feed states rejected on createOrder and execute, checkOrder reports reason 4; cancel refunded with a dead oracle; recovery to a healthy feed works |
| router allowlist: unknown targets, tokens, partial spends, wrong output and garbage calldata are rejected | PASS | 10s | 6 hostile executions rejected (order stayed OPEN, escrow and allowances untouched); honest execution through router B paid 0.119761 USDC to the owner (tx 0x7029402a38...) |
| router disable is instant and owner-only, and the keeper fails over to the other allowlisted router | PASS | 52s | disableSwapTarget took effect at once (tx 0xe65e00b81b...); outsider rejected; router A rejected with good calldata; the keeper executed a fresh order through router B; re-enable of A queued (timelocked) |

Transactions per scenario:

- **timelock: a queued change cannot be applied early, is fully visible, and can be cancelled** (PASS)
  - sent: queueSwapTarget [`0x024f4d00…d20e`](https://explorer.testnet.arc.io/tx/0x024f4d00219ae0e2d2fa0c1c4045c2e7cdd58ef9824968d1a60a69c743b7d20e), cancelConfig [`0x5cce1a78…d820`](https://explorer.testnet.arc.io/tx/0x5cce1a78dfd8f5c5b670393475b751db32743613b33e73b00e61b00e4370d820)
- **ownership: renounce is disabled and a pending transfer does not change the owner** (PASS)
  - sent: transferOwnership [`0xee519a4b…2217`](https://explorer.testnet.arc.io/tx/0xee519a4beb3353056280813c9824fd57f9c10e2f5a1d028e02cce69a4d9d2217), transferOwnership [`0x77a46f2c…d4a8`](https://explorer.testnet.arc.io/tx/0x77a46f2c1480bdca06791c46a49a587d8979e3f1dcb6fb4750727e4d07a8d4a8)
- **pause: blocks new orders and execution but never blocks cancel and refund** (PASS)
  - sent: set [`0x824f50dc…103f`](https://explorer.testnet.arc.io/tx/0x824f50dcbf874142dc6fe0288aac7a216a64c2074f3c6538770a1db13072103f), createOrder [`0x24d610b3…c5bd`](https://explorer.testnet.arc.io/tx/0x24d610b3aaecea0dbc5ad3a76956a4017a36945259f6fe55a3bdfd9d72acc5bd), pause [`0x12dbc6f6…5d43`](https://explorer.testnet.arc.io/tx/0x12dbc6f6632d741f6602cb993f2a330bea6b0d15fed23b8d2cf412fc1c075d43), cancelOrder [`0xf7260377…1850`](https://explorer.testnet.arc.io/tx/0xf7260377f19890fe3b831196c42f34d6499ce71ed85dd97e38760c19d30b1850), unpause [`0xa62b3b65…43b3`](https://explorer.testnet.arc.io/tx/0xa62b3b658a2c028ead600d8f4d37e31a9ce331749308a51a0ddc5dd147b743b3)
- **oracle: stale, future-dated, mismatched-round, non-positive and reverting feeds are all rejected; funds stay recoverable** (PASS)
  - sent: set [`0xc4f2e479…0f17`](https://explorer.testnet.arc.io/tx/0xc4f2e479458e7b8420bd9c90ae7242771e8c3bcdf857a5136458c160434b0f17), createOrder [`0x63af4445…c463`](https://explorer.testnet.arc.io/tx/0x63af4445d54ae8b562b0c410f352efb9eb7b29a20913f01a375c33d6b791c463), set [`0xd0783b95…d92c`](https://explorer.testnet.arc.io/tx/0xd0783b952fe9ecaa55a8a84475cd5093264f4620d86107f3708913e4a621d92c), set [`0x9625cbb6…c37e`](https://explorer.testnet.arc.io/tx/0x9625cbb62f611e5c00590f635d17ffbcdcad002d8218d125f5a7fa260854c37e), set [`0x524a2623…c4df`](https://explorer.testnet.arc.io/tx/0x524a26239256f618495c7fb23f1fc7477ce1609bf8564833629f571c4ad4c4df), set [`0x920b4354…7452`](https://explorer.testnet.arc.io/tx/0x920b43544e6bf78c6eb8c35be350af4775b4d577c4bef2ccbc95b51091107452), set [`0x4d78a6c4…8b27`](https://explorer.testnet.arc.io/tx/0x4d78a6c40ae9b5b9331714a37b1dcc1aa705e40b3ee6033bfc2dc7b5240e8b27), setBroken [`0x9bb84fc4…8821`](https://explorer.testnet.arc.io/tx/0x9bb84fc40e05198207eaa79f55ecd9623232b77eeb5b1de18d78e3be52ee8821), cancelOrder [`0xe6a829c5…936c`](https://explorer.testnet.arc.io/tx/0xe6a829c5454c150da9b22a01972e7e606c34970c07e7126cc40d88f482ad936c), setBroken [`0x95cd7ba9…59a6`](https://explorer.testnet.arc.io/tx/0x95cd7ba9be234e3ca0110172fcb09c819d0188fda8717ca7c18bb633a33359a6), set [`0xd5e1bdcd…f9d4`](https://explorer.testnet.arc.io/tx/0xd5e1bdcd17b9a921499ff07475f0d568e3cc9017c803e9c7b28075e8662ef9d4), createOrder [`0xfff594c3…152b`](https://explorer.testnet.arc.io/tx/0xfff594c35dd279fc3d676b031e9f395ae2bd1e9b3d74062cd9145e94094d152b), cancelOrder [`0x9ef8735c…51b6`](https://explorer.testnet.arc.io/tx/0x9ef8735c9045c61dc52e48c2f27ed5f856b83eb1fd36eaa2ce2a8fc85a0351b6)
- **router allowlist: unknown targets, tokens, partial spends, wrong output and garbage calldata are rejected** (PASS)
  - sent: setFeed [`0xf13f43bc…fa2f`](https://explorer.testnet.arc.io/tx/0xf13f43bcade2d988df85766807a69ec17487c2f442a9e7120609de07b3a8fa2f), setFeed [`0xa7c78953…882c`](https://explorer.testnet.arc.io/tx/0xa7c78953e69fd87207372589b48b7106eb59c17b591ec85720342d5eaaa6882c), set [`0x5e202126…af32`](https://explorer.testnet.arc.io/tx/0x5e2021265a0bd2d346bc1965841b3ad5f1b957184e09e4d9be2c62671f88af32), createOrder [`0xe5d44e77…d0d4`](https://explorer.testnet.arc.io/tx/0xe5d44e77db722bc0f1b645387ad13c7370a6936c3b4049fe95c0f767f781d0d4), execute [`0x7029402a…a841`](https://explorer.testnet.arc.io/tx/0x7029402a3830eafdc4760d96f6ca69760edcc3794579ff4b98c36c68dda3a841)
- **router disable is instant and owner-only, and the keeper fails over to the other allowlisted router** (PASS)
  - sent: disableSwapTarget [`0xe65e00b8…310d`](https://explorer.testnet.arc.io/tx/0xe65e00b81b21a560fca3e6c7c9d9bb057374eadbe78a2e253fa1c7adc9a5310d), set [`0xf5bb4572…7b46`](https://explorer.testnet.arc.io/tx/0xf5bb45726ce594bf56bf7ee288d0b99f9b8ede5bce10dd23abb12a54548a7b46), createOrder [`0x42acdec9…63a3`](https://explorer.testnet.arc.io/tx/0x42acdec9e8ca094879fa395c5bc89e213f4ffe94586c1f39e2ec58ba049e63a3), cancelOrder [`0xb38810e4…488a`](https://explorer.testnet.arc.io/tx/0xb38810e4bd71248a33eb941ddccf195b1cf534effd3d0be5ab9115a9a383488a), faucet [`0x6e61897c…133d`](https://explorer.testnet.arc.io/tx/0x6e61897c2f2559483d49363f862f8b0cae85e30df9806dcf6bc0bed157a2133d), approve [`0xfa320867…1558`](https://explorer.testnet.arc.io/tx/0xfa320867461f8dc7036ef7269f5e28570743949ff0501438b6cd796e377e1558), createOrder [`0xbe6e3d9b…91a9`](https://explorer.testnet.arc.io/tx/0xbe6e3d9bf79914b3e5816b627099258b565a84eaf2f13ba36ed24ff4e53691a9), setPrice [`0x0812ea8f…75e6`](https://explorer.testnet.arc.io/tx/0x0812ea8f18e49272780e40989775141269de0892901536fef78f6b79687175e6), keeper execute (router B) [`0xc093d15e…5bb6`](https://explorer.testnet.arc.io/tx/0xc093d15e9d1ae9505982a4db4009cd7af48a98b4cedb1c977cd7e1108d9e5bb6), queueSwapTarget [`0x0df76b7d…1d63`](https://explorer.testnet.arc.io/tx/0x0df76b7d21df575ad0020e40299a0f6a942c71321a7d3b5b6dc71fb376371d63)

## History: earlier runs (failures kept on purpose)

### Main run (reduced sizes)

Run at 2026-11-11T22:52:47.446Z, order contract `0xa83efe842010dbd470dfe7cc210d61c4edd908aa`, trader `0x478fAe148CEd6d1b2Ba8220EDe65CC2cAdB505FA`. Result: **7/12 scenarios passed**.

| Scenario | Result | Time | Detail |
| --- | --- | --- | --- |
| oracle reads test feeds through the order contract | PASS | 1s | tBTC $90091.38, tETH $2076.41, tSOL $76.72 |
| stop-loss sells on a drop | PASS | 15s | filled at 1906.46 |
| take-profit sells on a rise | FAIL | 154s | timeout waiting for tp fill |
| OCO: take-profit leg fires once and the order cannot run again | FAIL | 157s | timeout waiting for oco fill |
| stop-limit: activation persists, no fill below the limit, fills after a rebound | FAIL | 172s | timeout waiting for stop-limit fill |
| cancel refunds the escrow | FAIL | 3s | The method "eth_sendRawTransaction" does not exist / is not available. /  / URL: https://rpc.testnet.arc.io |
| expired order is refunded by a keeper | PASS | 50s | expired and refunded |
| DCA buys on schedule, then pause, resume and cancel refund the rest | PASS | 10s | 1 buy executed (0.1 USDC), the remaining budget was refunded |
| market swap through the test router (what the UI sends) | PASS | 3s | 0.3 USDC bought 0.000044964362240362 tETH |
| v2: an order below the minimum size is rejected | PASS | 1s | 0.05 USDC rejected (minimum 0.1) |
| v2: paged views agree with the full id list | PASS | 1s | 6 orders, page of 3 matches |
| v2: a keeper batches several ready orders into one executeMany transaction | FAIL | 157s | timeout waiting for all three batch orders executed |

Transactions per scenario:

- **stop-loss sells on a drop** (PASS)
  - sent: createOrder [`0x05a608ba…6e23`](https://explorer.testnet.arc.io/tx/0x05a608baa26d2b891f9abfeccbb3261a77b646f9c67b0e24bda33324c03e6e23), setPrice [`0x2e629746…001a`](https://explorer.testnet.arc.io/tx/0x2e629746e4a2a95a8c2fa33ecf589eed257be2f1601b85f65be3ed9eba41001a), setPrice [`0x93e24cf3…2547`](https://explorer.testnet.arc.io/tx/0x93e24cf35efe806633f923fc3755e00b217fb2f6f4c273fb3a75a4e68e062547)
  - on-chain events (keeper transactions): OrderExecuted#32 [`0xc6a14128…36db`](https://explorer.testnet.arc.io/tx/0xc6a14128fd6567214cdba8d7bf1dd141148fe7194659474eb3dbc04c646d36db)
- **take-profit sells on a rise** (FAIL)
  - sent: createOrder [`0xdc10a976…e3e1`](https://explorer.testnet.arc.io/tx/0xdc10a9764842745810eba2d2b56fc49337991e0808aade34cd022bdf8b54e3e1), setPrice [`0x4e5a7f8a…acf4`](https://explorer.testnet.arc.io/tx/0x4e5a7f8acc1ca57747f83dedc93815d8b89306bf61d016608cf195506286acf4)
  - on-chain events (keeper transactions): OrderExecuted#28 [`0x43e2dd1e…de0e`](https://explorer.testnet.arc.io/tx/0x43e2dd1eb33feabaf29c0707509391c18278f444c29935f2f69a3438f86cde0e), BatchItemFailed#33 [`0x43e2dd1e…de0e`](https://explorer.testnet.arc.io/tx/0x43e2dd1eb33feabaf29c0707509391c18278f444c29935f2f69a3438f86cde0e)
- **OCO: take-profit leg fires once and the order cannot run again** (FAIL)
  - sent: createOrder [`0xf78c8492…5fef`](https://explorer.testnet.arc.io/tx/0xf78c8492def275764e7b9bfd2d5c66f547055d9d70c1784da1b7de1d54ae5fef), setPrice [`0x67182a08…4466`](https://explorer.testnet.arc.io/tx/0x67182a08fcb5141f3b18e11ee3da49b382b49228e4628258ab367ab4a0aa4466)
- **stop-limit: activation persists, no fill below the limit, fills after a rebound** (FAIL)
  - sent: createOrder [`0x03ac7132…bdc0`](https://explorer.testnet.arc.io/tx/0x03ac713236d508830762136d716fe55a1a56d999793caac784d3e284afd4bdc0), setPrice [`0xa4ea1afd…3915`](https://explorer.testnet.arc.io/tx/0xa4ea1afd92c5d9e5595de7ab3ee8bf801df96850686372bdfc93998db4913915), setPrice [`0xd1e7f1f7…066b`](https://explorer.testnet.arc.io/tx/0xd1e7f1f75871c42316a2a06eac44a5a7cb858cefe02723f8eb524012aebb066b)
  - on-chain events (keeper transactions): StopActivated#35 [`0x25de42ae…be89`](https://explorer.testnet.arc.io/tx/0x25de42aeb1eba3baee1bbac5a09e5ad6dac50fce73eaedd88642f74171d1be89)
- **cancel refunds the escrow** (FAIL)
  - sent: createOrder [`0xf29aac59…1835`](https://explorer.testnet.arc.io/tx/0xf29aac596288b8e2323bc7620dc8573f4f974e2b381136fed249363021211835)
- **expired order is refunded by a keeper** (PASS)
  - sent: createOrder [`0x8cf9168b…fefe`](https://explorer.testnet.arc.io/tx/0x8cf9168be6eb3319b4319db0ac891809495908cd67793c435019ba01d9dffefe)
  - on-chain events (keeper transactions): OrderExpired#37 [`0x375cae54…2b19`](https://explorer.testnet.arc.io/tx/0x375cae54543dc167698eddbe486f4ba976275362375f1c9ad8a1dce0428d2b19)
- **DCA buys on schedule, then pause, resume and cancel refund the rest** (PASS)
  - sent: createDca [`0x2e808d68…b273`](https://explorer.testnet.arc.io/tx/0x2e808d68d4e4575f8e0688101b7d80f6e58106cdb5119493de7de720db64b273), pauseDca [`0x09e6c984…2650`](https://explorer.testnet.arc.io/tx/0x09e6c98466d5374108d09587db42d01d656846ace0ad427407d084cbca262650), resumeDca [`0x7d55695a…0cb5`](https://explorer.testnet.arc.io/tx/0x7d55695af4e9aca71aa4459a5c84d61f06a0ee6c46054000ea49f2905baf0cb5), cancelDca [`0x234d644f…f399`](https://explorer.testnet.arc.io/tx/0x234d644fbd389000f134bb9b93b26d1000eeb68b946031e9a46b528a5ea0f399)
  - on-chain events (keeper transactions): DcaExecuted#2 [`0x4e46994f…858c`](https://explorer.testnet.arc.io/tx/0x4e46994fd59a40256e3e530d4a901cf3dac91209e092154697d8bab21079858c)
- **market swap through the test router (what the UI sends)** (PASS)
  - sent: approve [`0x7bfeefd8…8cdb`](https://explorer.testnet.arc.io/tx/0x7bfeefd88e8352aa215100d9aac99c9b8d9405b7899535d46827348e830d8cdb), swapExactIn [`0x4894b080…f70c`](https://explorer.testnet.arc.io/tx/0x4894b080e4cf81ddf05b06c8acb5e666d2ed292f4194b338c575a8e4632ef70c)
- **v2: a keeper batches several ready orders into one executeMany transaction** (FAIL)
  - sent: createOrder [`0x969d7785…b26c`](https://explorer.testnet.arc.io/tx/0x969d7785991efe835909e604ff9e6929e7c8cf0895e3d5b226cd02e0a11ab26c), createOrder [`0x85f1d4ea…d12d`](https://explorer.testnet.arc.io/tx/0x85f1d4ea14ccd63e2e23ea6ebaadd80119893024e8c4707d7f7004e4a5f2d12d), createOrder [`0xc16a7129…f39f`](https://explorer.testnet.arc.io/tx/0xc16a712966480d771f6cdda9f290b84fee49aca08756bf1f51816cf6f70ef39f), setPrice [`0x4f06e763…7dea`](https://explorer.testnet.arc.io/tx/0x4f06e76335666442e50ae0accae0cb11070e005b1322406f075f2ab013db7dea)
  - on-chain events (keeper transactions): OrderExecuted#38 [`0x3d70d02a…53d6`](https://explorer.testnet.arc.io/tx/0x3d70d02ad5fd9c5a231ea90c198764dffe9f6b6d61f34639cb8c29f23f2853d6), OrderExecuted#39 [`0x3d70d02a…53d6`](https://explorer.testnet.arc.io/tx/0x3d70d02ad5fd9c5a231ea90c198764dffe9f6b6d61f34639cb8c29f23f2853d6), BatchItemFailed#40 [`0x3d70d02a…53d6`](https://explorer.testnet.arc.io/tx/0x3d70d02ad5fd9c5a231ea90c198764dffe9f6b6d61f34639cb8c29f23f2853d6)

### Rerun of scenarios that hit empty routers

Run at 2026-11-11T23:06:32.027Z, order contract `0xa83efe842010dbd470dfe7cc210d61c4edd908aa`, trader `0xD79709721FFD677E3c6719361207FCA253c50EDB`. Result: **2/5 scenarios passed**.

| Scenario | Result | Time | Detail |
| --- | --- | --- | --- |
| take-profit sells on a rise | PASS | 11s | filled at 82.8376811594203 |
| OCO: take-profit leg fires once and the order cannot run again | FAIL | 160s | timeout waiting for oco fill |
| stop-limit: activation persists, no fill below the limit, fills after a rebound | FAIL | 172s | timeout waiting for stop-limit fill |
| cancel refunds the escrow | PASS | 4s | escrow taken then fully refunded |
| v2: a keeper batches several ready orders into one executeMany transaction | FAIL | 157s | timeout waiting for all three batch orders executed |

Transactions per scenario:

- **take-profit sells on a rise** (PASS)
  - sent: createOrder [`0x16a0f11b…681c`](https://explorer.testnet.arc.io/tx/0x16a0f11b566d432d7327bd57557e3a22f43e1203c09beae895c776e20f05681c), setPrice [`0x6b8cdfb0…d182`](https://explorer.testnet.arc.io/tx/0x6b8cdfb0713363c44bfa89b2a2033df8d928203312844b18ad2688a5919ad182), setPrice [`0x3cc0bdbb…7ea2`](https://explorer.testnet.arc.io/tx/0x3cc0bdbbc42412ad17c169b4c17774e27f28e4d451c2f1972c5d5244af927ea2)
  - on-chain events (keeper transactions): OrderExecuted#33 [`0x269ecbc8…7bc5`](https://explorer.testnet.arc.io/tx/0x269ecbc893644edcf18705c6d2c4e6df9994422a49294b1dc93d80d8b8647bc5), OrderExecuted#47 [`0x269ecbc8…7bc5`](https://explorer.testnet.arc.io/tx/0x269ecbc893644edcf18705c6d2c4e6df9994422a49294b1dc93d80d8b8647bc5)
- **OCO: take-profit leg fires once and the order cannot run again** (FAIL)
  - sent: createOrder [`0xec388ad9…a30f`](https://explorer.testnet.arc.io/tx/0xec388ad9c9be77a6b9be87f53c03d2c97b8a549cc41c1f7f034c41e8f0aba30f), setPrice [`0x3b5b1911…bed0`](https://explorer.testnet.arc.io/tx/0x3b5b1911caacc7f6fdb32afaa74ab1c864afb01304e14dec76080b9f79f1bed0)
- **stop-limit: activation persists, no fill below the limit, fills after a rebound** (FAIL)
  - sent: createOrder [`0xca045a5a…91cd`](https://explorer.testnet.arc.io/tx/0xca045a5a2798c05245e89df19ba7acd2f1b91cc6983651b3cdd56b18cb3691cd), setPrice [`0x08d0782e…07c0`](https://explorer.testnet.arc.io/tx/0x08d0782ec9c222666db5ca9b1842fe5ce21b3cb50a0a1cc7814ffdb3703b07c0), setPrice [`0x0fa2c331…7273`](https://explorer.testnet.arc.io/tx/0x0fa2c3313a1d0a23f9f677d1fa42b4b88df34902cf56fc84993fe18654f77273)
  - on-chain events (keeper transactions): StopActivated#49 [`0x13301f61…37cf`](https://explorer.testnet.arc.io/tx/0x13301f611f71a5ba45956991ef9fe8cbbade6b998d5f3f7015c2e19cd13e37cf)
- **cancel refunds the escrow** (PASS)
  - sent: createOrder [`0x9b4a8ab5…e769`](https://explorer.testnet.arc.io/tx/0x9b4a8ab55284021a7c3d1c4e1362c09bad0bcfbcfa21293dee434b2d9414e769), cancelOrder [`0x8967b26c…3717`](https://explorer.testnet.arc.io/tx/0x8967b26c6035e8aa9d47785f0bfc68c690d5a58c446d08c6e749abe074473717)
- **v2: a keeper batches several ready orders into one executeMany transaction** (FAIL)
  - sent: createOrder [`0xba04cb10…b8f6`](https://explorer.testnet.arc.io/tx/0xba04cb10f411f4722abc9dff8e783e8d01548ab3ad9bcba06c9db2abe89ab8f6), createOrder [`0xca7bbfb0…924c`](https://explorer.testnet.arc.io/tx/0xca7bbfb03b9c4373446d343907afbe608824009984dd2ba983a0b6757952924c), setPrice [`0x723787a0…714f`](https://explorer.testnet.arc.io/tx/0x723787a0123bfcb9a6c439f1ee958981385451d88d4822c6021e15b8e97b714f)

### Clean-state rerun (OCO and stop-limit)

Run at 2026-11-12T01:15:26.585Z, trader `0x7116C809e7aF70c212250bC81E2D8c0d2CB56531`, after all earlier open orders had expired. Result: **2/2 scenarios passed**.

| Scenario | Result | Time |
| --- | --- | --- |
| OCO: take-profit leg fires once and the order cannot run again | PASS | 12s |
| stop-limit: activation persists, no fill below the limit, fills after a rebound | PASS | 29s |

Transactions:

- **OCO: take-profit leg fires once and the order cannot run again**
  - sent: createOrder [`0x8c2b0624…edac`](https://explorer.testnet.arc.io/tx/0x8c2b0624f7ff293e4e086a914b5efd619254d5916f767bc89493f2747debedac), setPrice [`0xc384bdee…c7d8`](https://explorer.testnet.arc.io/tx/0xc384bdeeb3878c9ec04c72c5fd0aadec66a96181d5343a61a82ae672f41fc7d8), setPrice [`0xa612c4c4…626d`](https://explorer.testnet.arc.io/tx/0xa612c4c4e0373fd53e59a43062173ca2c2b896c073a1454572c7d296a9ed626d)
  - on-chain events (keeper transactions): OrderExecuted#53 [`0x5c67a9df…f800`](https://explorer.testnet.arc.io/tx/0x5c67a9dff71e2cb2c159ecbb7de07750c8b2e304e8649ad40d219fb04f6bf800)
- **stop-limit: activation persists, no fill below the limit, fills after a rebound**
  - sent: createOrder [`0x6ff3b9f3…e31d`](https://explorer.testnet.arc.io/tx/0x6ff3b9f3e29421f1919a65bfb46c87da70533c48bf82f385ae7cd8bb9737e31d), setPrice [`0xb1d549a7…e3fc`](https://explorer.testnet.arc.io/tx/0xb1d549a763ea4e1f3e7ee19f1e49f414b7a557d93484505afa52ff17be9be3fc), setPrice [`0x26b88b2b…95ee`](https://explorer.testnet.arc.io/tx/0x26b88b2bb3537c2dc8c806c2f122e66820e4f32f376d8b25dbaf5a4ae04795ee), setPrice [`0xa8e78f56…6682`](https://explorer.testnet.arc.io/tx/0xa8e78f56aa133c94aac58c67c14188bbf1a7776ebdfe144c85bae614b4bc6682)
  - on-chain events (keeper transactions): StopActivated#54 [`0xe452e589…8e34`](https://explorer.testnet.arc.io/tx/0xe452e5899786b40fc7ce5a2c8a417db291aa7051a93641696c2730c77e8c8e34), OrderExecuted#54 [`0x1f891b69…bb6b`](https://explorer.testnet.arc.io/tx/0x1f891b69b1f50ac1ef8a87356423d2af527d13dc88ccbb37c5607b5b6805bb6b)

### Earlier security run (6/8, router liquidity exhausted)

Run at 2026-11-11T22:56:39.993Z, order contract `0xa83efe842010dbd470dfe7cc210d61c4edd908aa`, trader `0xE90A4B44C9f6079137863a529cB2c5d752e76571`. Result: **6/8 scenarios passed**.

| Scenario | Result | Time | Detail |
| --- | --- | --- | --- |
| access control: a non-owner cannot call any admin function | PASS | 3s | 11 admin functions all rejected the outsider: queueTokenConfig, queueSwapTarget, applyConfig, cancelConfig, disableToken, disableSwapTarget, setKeeperFeeBps, setMinOrderQuote, pause, unpause, transferOwnership |
| timelock: a queued change cannot be applied early, is fully visible, and can be cancelled | PASS | 6s | eta = queue time + 3600s; ConfigQueued carries subject/flags; early apply -> ConfigNotReady; cancel clears it; later apply -> ConfigUnknown |
| keeper fee can only be lowered; minimum order size is bounded | PASS | 1s | raise fee 10 -> 11; min order 10,001 USDC rejected |
| ownership: renounce is disabled and a pending transfer does not change the owner | PASS | 4s | renounce -> RenounceDisabled; transferOwnership only sets pendingOwner; an outsider cannot accept; pending cleared |
| pause: blocks new orders and execution but never blocks cancel and refund | PASS | 15s | create and execute rejected while paused; cancel refunded 0.0012 tORC in full; unpaused |
| oracle: stale, future-dated, mismatched-round, non-positive and reverting feeds are all rejected; funds stay recoverable | PASS | 35s | 6 bad feed states rejected on createOrder and execute, checkOrder reports reason 4; cancel refunded with a dead oracle; recovery to a healthy feed works |
| router allowlist: unknown targets, tokens, partial spends, wrong output and garbage calldata are rejected | FAIL | 6s | allowlisted router, half the input (partial fill): reverted, but not with /PartialFill/: The contract function "execute" reverted with the following signature: 0xc480be2e  Unable to decode signature "0xc480be2e" as it was not found on the provided ABI. |
| router disable is instant and owner-only, and the keeper fails over to the other allowlisted router | FAIL | 143s | the keeper did not execute the order after router A was disabled |

Transactions per scenario:

- **timelock: a queued change cannot be applied early, is fully visible, and can be cancelled** (PASS)
  - sent: queueSwapTarget [`0x2194505f…287e`](https://explorer.testnet.arc.io/tx/0x2194505fd0997b541e3ad90679b658dec8c5472bbcbb75d8954dd8dc6a65287e), cancelConfig [`0x14dc74a1…b148`](https://explorer.testnet.arc.io/tx/0x14dc74a1fc9ef559e5f0629113545687c15e7cae6d92a681f924e368508ab148)
- **ownership: renounce is disabled and a pending transfer does not change the owner** (PASS)
  - sent: transferOwnership [`0x06c0a9b0…7c3f`](https://explorer.testnet.arc.io/tx/0x06c0a9b052a5f6bdba8147f4d157617b12fb622a36feabf32775bbd3ec167c3f), transferOwnership [`0x79b4ec6c…e51f`](https://explorer.testnet.arc.io/tx/0x79b4ec6cd26d7a74044b718ffa9f8d5a1e9ddc97f73514b734948d9ab3d8e51f)
- **pause: blocks new orders and execution but never blocks cancel and refund** (PASS)
  - sent: set [`0xbc73777d…87a8`](https://explorer.testnet.arc.io/tx/0xbc73777d21fff554d61a7c39791cf45c795f3c516585efabbbe5ec0e2f4087a8), createOrder [`0xda49066e…d5b7`](https://explorer.testnet.arc.io/tx/0xda49066e2576200f3affa379394fd2025f5365bb8d1b7cc8cfebc1c1a56ed5b7), pause [`0xf28b6fa9…d5c9`](https://explorer.testnet.arc.io/tx/0xf28b6fa95c192ab3d71d06ec66361701dc51c8a58453f74cf73bdd45eee5d5c9), cancelOrder [`0x8dedb69a…f883`](https://explorer.testnet.arc.io/tx/0x8dedb69a365f1e4b7d10f94669bdde92864579b50dc41721560115b208baf883), unpause [`0x4056be9b…8261`](https://explorer.testnet.arc.io/tx/0x4056be9b192cef6a9d57d11553d19da06961900369d98e24a1815ee79a498261)
- **oracle: stale, future-dated, mismatched-round, non-positive and reverting feeds are all rejected; funds stay recoverable** (PASS)
  - sent: set [`0x1d4016e7…347f`](https://explorer.testnet.arc.io/tx/0x1d4016e78fc744d430f5832b63f7b9d8d527fdfd2678c2bf45034487b39c347f), createOrder [`0x41a249a5…0ba7`](https://explorer.testnet.arc.io/tx/0x41a249a522b0be41fb62ed8d79fde6625ca4df9e0e2b4f0524ca7cf0a05f0ba7), set [`0x414a4ebd…790d`](https://explorer.testnet.arc.io/tx/0x414a4ebdc86b24416b125cca37ccb06a1c91d334a972c56e583df4a6992b790d), set [`0xc30447fe…aceb`](https://explorer.testnet.arc.io/tx/0xc30447fe8601dd01a6b7da6ee1204f333b47f7172e2242d4f57b5c00870baceb), set [`0xf81e954b…b8a7`](https://explorer.testnet.arc.io/tx/0xf81e954b942645320221a9291565e7534e8db4d873748d7a5ed8dd0485f5b8a7), set [`0x4ec780dc…4bc9`](https://explorer.testnet.arc.io/tx/0x4ec780dcf34472f04412a03aee714d5d92be743305b93b673ff5661f43d44bc9), set [`0x92b9c0ca…1af8`](https://explorer.testnet.arc.io/tx/0x92b9c0ca450024ae0c818e3df34c5c216e014f5fb49793945cd759dc2fc91af8), setBroken [`0xf6534ecc…1a86`](https://explorer.testnet.arc.io/tx/0xf6534eccba5f54411ed1d653695c2b2b749db6a8627aeaa4f701ce2d3b611a86), cancelOrder [`0x797cba63…b86d`](https://explorer.testnet.arc.io/tx/0x797cba63a0e2101af1b797f9b3c9d8326070a25b6053286a49a3ff996f43b86d), setBroken [`0x1e008606…89f6`](https://explorer.testnet.arc.io/tx/0x1e008606585413df1955622d6f3ad44bcbaabf5bbdec429ee825a6a4505289f6), set [`0x2a3581c1…799b`](https://explorer.testnet.arc.io/tx/0x2a3581c139647bd97726388222d9c74177984a6ea56c20f1df35487a8902799b), createOrder [`0x10e58f7d…debe`](https://explorer.testnet.arc.io/tx/0x10e58f7da421fea376ad0df116bc42350d6a2e547ba6a071a322babde40cdebe), cancelOrder [`0x01d65a90…4b28`](https://explorer.testnet.arc.io/tx/0x01d65a90b84dfac25a1e751218e7941c20c127ab31ba98605b860005c6a44b28)
- **router allowlist: unknown targets, tokens, partial spends, wrong output and garbage calldata are rejected** (FAIL)
  - sent: setFeed [`0x60a955a6…cba9`](https://explorer.testnet.arc.io/tx/0x60a955a68460dbef842f17a6d63e9efbfc4af80ff92be818ecaa909262dfcba9), setFeed [`0x4fd49c2d…4982`](https://explorer.testnet.arc.io/tx/0x4fd49c2da9a227bc2b1de37031441c915ef484ba866a58c0373c0cf7fcd74982), set [`0x5ded64cc…2c5b`](https://explorer.testnet.arc.io/tx/0x5ded64cc5efb3f97efa078e9885c2daf9494ff3dc27116f44072c328e0f22c5b), createOrder [`0x805e47f0…7d48`](https://explorer.testnet.arc.io/tx/0x805e47f06cfca90665c493652ae27534c21caead5f5c2581e32446e7bc857d48)
- **router disable is instant and owner-only, and the keeper fails over to the other allowlisted router** (FAIL)
  - sent: disableSwapTarget [`0x024c2318…dad6`](https://explorer.testnet.arc.io/tx/0x024c2318d04007943af565004468b66f93fc04f7e150ce7fac0551dbbbe3dad6), set [`0x2842bddc…e24a`](https://explorer.testnet.arc.io/tx/0x2842bddc4cdb8993a5bb96bbad236535c34456b1872c975183e417fd95f2e24a), createOrder [`0x1841dd6e…f3a2`](https://explorer.testnet.arc.io/tx/0x1841dd6ef7c181d5f27687bf591029f0d96971991e89f5346bca9b6b35b2f3a2), cancelOrder [`0x264c4fa7…0c1c`](https://explorer.testnet.arc.io/tx/0x264c4fa7957791a464761c72402c0d9ed0d1ec4b57b748f166815acda5dc0c1c), faucet [`0xbc2514f0…b629`](https://explorer.testnet.arc.io/tx/0xbc2514f057e992e8800bced956341cd919acf8afa690cb44b88adb6aa842b629), approve [`0x53b9f6f5…dbf4`](https://explorer.testnet.arc.io/tx/0x53b9f6f5b53164a3bfedbe6c410e4d5d863d9df6ee3c0324fdf86f144c9edbf4), createOrder [`0x4f669958…103e`](https://explorer.testnet.arc.io/tx/0x4f6699587186681d141b9575ee627f615fab34a9c096303fa3c7125cdfe7103e), setPrice [`0x05ce1334…0617`](https://explorer.testnet.arc.io/tx/0x05ce1334872cff2ebc42c434737f7138ac4e78fd5e510cd0b05bb3e1a6750617)

