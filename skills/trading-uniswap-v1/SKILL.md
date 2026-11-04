---
name: trading-uniswap-v1
description: Uniswap-based autonomous ETH-USDC trading on Base through the independent engine.
auto-activate: true
---
Read trading_status for the actual paper/live mode, study and portfolio. The guardian studies closed candles, selects on training data, evaluates a separate holdout, then uses its own current Uniswap quote and fixed router templates. trading_tick requests only a due cycle; never loop it to bypass cadence. The V1 has no leverage and trades only ETH/WETH and canonical USDC on Base. Capital is the supported wallet minus gas and outstanding service reservations. No confirmation is required for each order once the owner enables live mode. Never replace this route with an upstream CLI signer or arbitrary approvals. Historical advantage is not a probability of profit. See docs/TRADING_V1.fr.md and integrations/trading-skills.lock.json for upstream provenance.
