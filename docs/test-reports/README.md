# Live testnet test report (Arc Testnet, order contract v2)

Campaign of 2026-11-11 (UTC), run against the unaudited v2 `ArcTradeOrders` at `0xa83efe842010dbd470dfe7cc210d61c4edd908aa` on Arc Testnet (chain 5042002). Nothing was sent to mainnet. All hashes below are public testnet transactions; click through to verify. Raw data: [e2e-main.json](e2e-main.json), [e2e-rerun.json](e2e-rerun.json), [e2e-security.json](e2e-security.json).

**Honest summary.** The contract and keeper behaved correctly wherever the test environment was able to run the scenario. Several scenarios did **not** complete because the testnet harness ran out of USDC (the test routers pay sell proceeds from their own balance, and testnet USDC comes from a captcha-gated faucet that automation cannot use). Those scenarios are marked *not verified live* below and are not claimed as passed. The campaign also found two real keeper defects and one missing resilience feature; all three are fixed (see "Defects found").

## What was verified, against what you asked for

| Requirement | Status | Evidence |
| --- | --- | --- |
| DCA execution | **Verified live** | create/pause/resume/cancel and one keeper buy (DcaExecuted id 2) in "e2e-main": DCA scenario. Plan paused, resumed, cancelled; the rest of the budget was refunded |
| Stop-loss execution | **Verified live** | "e2e-main": stop-loss filled by the keeper (OrderExecuted id 32). Also passed in the earlier v2 run (21:03 UTC, hashes not recorded) and on the v1 harness |
| Take-profit execution | **Verified live** | "e2e-rerun": take-profit filled by the keeper (OrderExecuted id 47). Also passed in the 21:03 run |
| Batch execution, multiple orders | **Verified live (2 orders per batch, three transactions)** | Three keeper `executeMany` transactions (selector `0x9c96f007`, status success): [`0x269ecbc8…7bc5`](https://explorer.testnet.arc.io/tx/0x269ecbc893644edcf18705c6d2c4e6df9994422a49294b1dc93d80d8b8647bc5) executed orders 33 and 47 in one transaction; [`0x3d70d02a…53d6`](https://explorer.testnet.arc.io/tx/0x3d70d02ad5fd9c5a231ea90c198764dffe9f6b6d61f34639cb8c29f23f2853d6) executed orders 38 and 39 and **skipped order 40 with `BatchItemFailed`** (router out of USDC), proving per-item isolation; [`0x43e2dd1e…de0e`](https://explorer.testnet.arc.io/tx/0x43e2dd1eb33feabaf29c0707509391c18278f444c29935f2f69a3438f86cde0e) executed 28 and logged 33 as failed. A batch of three completing fully was *not* demonstrated (router liquidity) |
| Router allowlist validation | **Partly verified live** | Unauthorised targets: the first three hostile executions (random address, a token, the orders contract as target) were rejected with `SwapTargetNotAllowed` before the scenario hit the liquidity problem. The remaining hostile cases (half-input partial fill, wrong output token, garbage calldata) and the honest-execution-leaves-no-approval check are covered by Foundry tests (191 passing) but were **not verified live**: the test router reverted with its own `InsufficientLiquidity` (`0xc480be2e`) first. Also verified live: an outsider cannot disable a router |
| Router failure handling / failover | **Not verified live** | The scenario (disable router A instantly, keeper must route through router B) failed for liquidity. What did happen live: router A was disabled onchain ([`0x024c2318…dad6`](https://explorer.testnet.arc.io/tx/0x024c2318d04007943af565004468b66f93fc04f7e150ce7fac0551dbbbe3dad6)), router A had run dry, and the keeper's new provider-fallback code recorded 3 fallbacks to the other router in the main run (keeper metric `providerFallbacks: 3`). Re-enable of router A is queued (timelocked). Foundry covers the contract side |
| Oracle stale price protection | **Verified live** | "e2e-security": stale (2 min old against a 60 s limit), future-dated, mismatched-round (`answeredInRound < roundId`), zero and negative answers, and a reverting feed were each rejected on `createOrder` and `execute`; `checkOrder` reported reason 4 (oracle unavailable) for each |
| Invalid round protection | **Verified live** | Same scenario: `answeredInRound < roundId` rejected as `StalePrice` (v2 addition) |
| Order cancellation and fund recovery | **Verified live** | Cancel refunds in "e2e-main" and "e2e-rerun"; expired order refunded by the keeper (OrderExpired id 37); DCA cancel refunded the remaining budget; **cancel while the oracle is dead** and **cancel while the contract is paused** both refunded in full ("e2e-security") |
| Timelock configuration | **Verified live** | "e2e-security": delay is exactly 3,600 s from the queue block; `ConfigQueued` carries subject and flags; early `applyConfig` reverts `ConfigNotReady`; `cancelConfig` clears the entry; applying a cancelled change reverts `ConfigUnknown`. The six v2 config changes were also applied only after their delay (apply transactions in the campaign log) |
| Access control | **Verified live** | "e2e-security": eleven admin functions all rejected a non-owner with `OwnableUnauthorizedAccount`; renounce reverts `RenounceDisabled`; a pending ownership transfer does not change the owner; keeper fee cannot be raised; minimum order size is bounded; pause blocks creation and execution but not cancel/refund |

## Scenarios not completed (need USDC and a clean slate)

- **OCO** and **stop-limit fill** on the v2 contract with the fixed keeper (stop-limit *activation* was persisted live: `StopActivated` id 49, id 35). Both passed on the v1 harness (11/11) and OCO passed in the 21:03 v2 run; the stop-limit fill timed out there (most likely the keeper backoff defect fixed since; not re-confirmed).
- **Batch of three**, **router allowlist hostile calldata (last three cases)**, **router failover**, **honest execution through an allowlisted router with zero standing approval**.
- To finish them: about 1.5 USDC of liquidity in the test routers, a trader wallet, and no stale open orders from earlier runs (they expire one hour after creation; the last expire around 00:06 UTC on 2026-11-12). The scripts are ready (`e2e.ts`, `e2e-security.ts`, `refill-routers.ts`). Claim testnet USDC for the deployer `0x43aBbA38cCfbfa7D0044104681542347dfCB34F7` at the Circle faucet and rerun.

## Defects found by the campaign (all fixed)

| Defect | How it showed | Fix |
| --- | --- | --- |
| Keeper and test script shared one key, so the keeper's explicit nonces raced the script's transactions | Random `setPrice`/`createOrder` reverts in the first runs | The keeper has its own key in `.env`. (In production the keeper key must never be shared.) |
| Retry backoff grew to 10 minutes | Stop-limit fill timed out after a brief unfillable window | Defaults 5 s base, 60 s cap (`KEEPER_BACKOFF_BASE_MS`, `KEEPER_BACKOFF_MAX_MS`) |
| If the best-ranked provider failed simulation the keeper never tried the next one | Orders stuck while the other router could fill | The keeper now simulates every allowlisted quote best-first and uses the first that succeeds (metric `providerFallbacks`) |
| v2 contract was 24,800 bytes, over the 24,576 limit | Testnet deployment failed at gas estimation | Trimmed to 23,778 bytes; CI runs `forge build --sizes` |
| Arc gas-fee `Transfer` log from `0xff…fe` broke swap verification | First live swap report was rejected | Ignored in `deriveSwap` |

## Environment limitations worth knowing

- Test routers pay sells from their own USDC. Stale open orders from earlier runs, owned by lost throwaway wallets, were executed by the keeper and drained that liquidity, which is why later scenarios failed. A fresh deployment, or waiting for expiry, avoids this.
- Wallet keys for the later runs are derived from the deployer key and a seed printed in the log, so leftover funds are recoverable. Earlier runs used random keys; roughly 4 testnet USDC in those wallets is unrecoverable.
- The sandbox clock and the machine's sleep state disturbed one earlier run (DNS failure while the machine was suspended); that run's failures were not counted.

## Raw results

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

### Security and failure-handling suite

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

