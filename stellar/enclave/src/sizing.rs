//! Per-vault trade sizing.
//!
//! Given a decrypted signal and a snapshot of one vault, its pools and the
//! oracle, decide the exact swap to authorize, or why to skip the vault. Every
//! limit the vault enforces on-chain is applied here first with the same
//! integer math, so the enclave only signs trades the vault will accept. The
//! vault re-checks everything anyway; snapshots come from the untrusted relayer.

use std::collections::BTreeMap;

use ethnum::U256;
use serde::{Deserialize, Serialize};

use crate::signal::Signal;

/// Basis-point denominator.
const BPS: u128 = 10_000;
/// Decimals of policy USD amounts (`sigmax_types::USD_DECIMALS`).
const USD_DECIMALS: u32 = 7;
/// Length of the vault's rolling trade window.
const WINDOW_SECS: u64 = 86_400;
/// Keep this much headroom before an oracle price or signal would go stale,
/// so the authorization is still valid when the transaction lands.
const STALENESS_MARGIN_SECS: u64 = 30;

/// An asset in the vault policy.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AssetSnap {
    pub token: String,
    pub symbol: String,
    pub decimals: u32,
}

/// A venue in the vault policy (pool plus pinned token order).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct VenueSnap {
    pub pool: String,
    pub tokens: Vec<String>,
}

/// One trade in the vault's rolling window.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TradeMark {
    pub timestamp: u64,
    #[serde(with = "crate::num::i128_str")]
    pub usd: i128,
}

/// The vault policy, as read from `Vault::policy`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicySnap {
    pub leader: String,
    pub assets: Vec<AssetSnap>,
    pub venues: Vec<VenueSnap>,
    pub max_trade_bps: u32,
    #[serde(with = "crate::num::i128_str")]
    pub max_trade_usd: i128,
    #[serde(with = "crate::num::i128_str")]
    pub max_daily_usd: i128,
    pub max_daily_trades: u32,
    pub max_slippage_bps: u32,
    pub max_signal_age_secs: u64,
    pub max_oracle_age_secs: u64,
    pub expires_at: u64,
}

/// Everything the enclave needs to know about one vault.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultSnapshot {
    pub vault: String,
    pub paused: bool,
    pub policy: PolicySnap,
    /// Token contract → vault balance (base units).
    #[serde(with = "crate::num::i128_map")]
    pub balances: BTreeMap<String, i128>,
    pub recent: Vec<TradeMark>,
    pub signal_used: bool,
}

/// One pool's live state.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PoolSnapshot {
    pub pool: String,
    pub tokens: Vec<String>,
    #[serde(with = "crate::num::u128_vec")]
    pub reserves: Vec<u128>,
    pub fee_bps: u32,
}

/// One oracle price.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PricePoint {
    #[serde(with = "crate::num::i128_str")]
    pub price: i128,
    pub timestamp: u64,
}

/// Oracle prices by ticker.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OracleSnapshot {
    pub decimals: u32,
    pub prices: BTreeMap<String, PricePoint>,
}

/// The on-chain record of the signal being executed.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignalRecordSnap {
    pub leader: String,
    pub seq: u32,
    pub ledger: u32,
    pub timestamp: u64,
}

/// Enclave-side sizing knobs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SizingConfig {
    /// `min_out` = pool estimate less this many basis points.
    pub slippage_bps: u32,
    /// Most of a pool's input reserve one signal may consume across all vaults.
    pub max_pool_share_bps: u32,
    /// Smallest trade worth sending, in policy USD units (7 decimals).
    pub min_trade_usd: u128,
}

impl Default for SizingConfig {
    fn default() -> Self {
        Self {
            slippage_bps: 50,
            max_pool_share_bps: 200,
            min_trade_usd: 10_000_000,
        }
    }
}

/// The swap to authorize for one vault.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Plan {
    pub pool: String,
    pub token_in: String,
    pub token_out: String,
    pub in_idx: u32,
    pub out_idx: u32,
    #[serde(with = "crate::num::u128_str")]
    pub amount_in: u128,
    #[serde(with = "crate::num::u128_str")]
    pub min_out: u128,
    #[serde(with = "crate::num::u128_str")]
    pub usd_value: u128,
}

/// Why a vault gets no trade for this signal.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Skip {
    #[error("vault is paused")]
    Paused,
    #[error("vault delegation expired")]
    Expired,
    #[error("vault follows another leader")]
    WrongLeader,
    #[error("vault already traded this signal")]
    SignalUsed,
    #[error("signal is too old for this vault")]
    SignalTooOld,
    #[error("asset {0} is not in the vault policy")]
    AssetNotInPolicy(String),
    #[error("no allowlisted pool with live state trades this pair")]
    NoVenue,
    #[error("pool token order changed since the owner pinned it")]
    VenueMismatch,
    #[error("oracle has no price for {0}")]
    OracleUnavailable(String),
    #[error("oracle price for {0} is stale")]
    OracleStale(String),
    #[error("vault holds none of the asset to sell")]
    NothingToSell,
    #[error("vault reached its daily trade count")]
    DailyTradeLimit,
    #[error("vault reached its daily USD volume")]
    DailyVolumeLimit,
    #[error("signal already used its share of pool depth")]
    PoolDepthExhausted,
    #[error("trade is below the minimum size")]
    TooSmall,
    #[error("pool price is outside the vault's oracle band")]
    PoolOutsideOracleBand,
    #[error("arithmetic overflow")]
    Math,
}

fn pow10(n: u32) -> U256 {
    U256::from(10u8).pow(n)
}

fn mul_div(a: u128, b: u128, c: u128) -> Result<u128, Skip> {
    if c == 0 {
        return Err(Skip::Math);
    }
    let r = U256::from(a) * U256::from(b) / U256::from(c);
    u128::try_from(r).map_err(|_| Skip::Math)
}

/// Vault formula: `amount * price * 10^7 / 10^(token_decimals + oracle_decimals)`.
pub fn usd_value(
    amount: u128,
    price: u128,
    token_decimals: u32,
    oracle_decimals: u32,
) -> Result<u128, Skip> {
    let r = U256::from(amount) * U256::from(price) * pow10(USD_DECIMALS)
        / pow10(token_decimals + oracle_decimals);
    u128::try_from(r).map_err(|_| Skip::Math)
}

/// Largest amount whose `usd_value` is at most `usd`.
fn amount_for_usd(
    usd: u128,
    price: u128,
    token_decimals: u32,
    oracle_decimals: u32,
) -> Result<u128, Skip> {
    if price == 0 {
        return Err(Skip::Math);
    }
    // usd_value(a) = floor(a * p * 10^7 / N) <= usd  <=>  a <= ((usd + 1) * N - 1) / (p * 10^7),
    // with N = 10^(token_decimals + oracle_decimals). The loop is a guard only.
    let n = pow10(token_decimals + oracle_decimals);
    let mut amount = u128::try_from(
        ((U256::from(usd) + U256::ONE) * n - U256::ONE) / (U256::from(price) * pow10(USD_DECIMALS)),
    )
    .map_err(|_| Skip::Math)?;
    while amount > 0 && usd_value(amount, price, token_decimals, oracle_decimals)? > usd {
        amount -= 1;
    }
    Ok(amount)
}

/// Vault formula: `amount_in * p_in * 10^out_dec / (p_out * 10^in_dec)`.
pub fn fair_output(
    amount_in: u128,
    p_in: u128,
    p_out: u128,
    in_dec: u32,
    out_dec: u32,
) -> Result<u128, Skip> {
    let r = U256::from(amount_in) * U256::from(p_in) * pow10(out_dec)
        / (U256::from(p_out) * pow10(in_dec));
    u128::try_from(r).map_err(|_| Skip::Math)
}

/// Constant-product output after an input fee, as Aquarius volatile pools compute it.
pub fn constant_product_out(
    amount_in: u128,
    reserve_in: u128,
    reserve_out: u128,
    fee_bps: u32,
) -> Result<u128, Skip> {
    let in_net = mul_div(amount_in, BPS - fee_bps as u128, BPS)?;
    let r = U256::from(reserve_out) * U256::from(in_net)
        / (U256::from(reserve_in) + U256::from(in_net));
    u128::try_from(r).map_err(|_| Skip::Math)
}

fn price_of(oracle: &OracleSnapshot, symbol: &str, now: u64, max_age: u64) -> Result<u128, Skip> {
    let p = oracle
        .prices
        .get(symbol)
        .ok_or_else(|| Skip::OracleUnavailable(symbol.to_string()))?;
    if p.price <= 0 {
        return Err(Skip::OracleUnavailable(symbol.to_string()));
    }
    if now.saturating_sub(p.timestamp) + STALENESS_MARGIN_SECS > max_age {
        return Err(Skip::OracleStale(symbol.to_string()));
    }
    Ok(p.price as u128)
}

/// Decide the swap for one vault. `used_in` is how much of each pool's input
/// reserve this signal already consumed in vaults authorized before this one.
// Pure function of distinct inputs; bundling them would only hide what it reads.
#[allow(clippy::too_many_arguments)]
pub fn plan_trade(
    signal: &Signal,
    record: &SignalRecordSnap,
    vault: &VaultSnapshot,
    pools: &[PoolSnapshot],
    oracle: &OracleSnapshot,
    now: u64,
    used_in: &BTreeMap<String, u128>,
    cfg: &SizingConfig,
) -> Result<Plan, Skip> {
    let policy = &vault.policy;
    if vault.paused {
        return Err(Skip::Paused);
    }
    if now >= policy.expires_at {
        return Err(Skip::Expired);
    }
    if policy.leader != record.leader || signal.leader != record.leader {
        return Err(Skip::WrongLeader);
    }
    if vault.signal_used {
        return Err(Skip::SignalUsed);
    }
    if now.saturating_sub(record.timestamp) + STALENESS_MARGIN_SECS > policy.max_signal_age_secs {
        return Err(Skip::SignalTooOld);
    }

    let find = |symbol: &str| {
        policy
            .assets
            .iter()
            .find(|a| a.symbol == symbol)
            .cloned()
            .ok_or_else(|| Skip::AssetNotInPolicy(symbol.to_string()))
    };
    let sell = find(signal.sell_symbol())?;
    let buy = find(signal.buy_symbol())?;

    // The allowlisted venue with the deepest input reserve.
    let mut best: Option<(&VenueSnap, &PoolSnapshot, usize, usize)> = None;
    for venue in &policy.venues {
        let (Some(i), Some(o)) = (
            venue.tokens.iter().position(|t| *t == sell.token),
            venue.tokens.iter().position(|t| *t == buy.token),
        ) else {
            continue;
        };
        let Some(pool) = pools.iter().find(|p| p.pool == venue.pool) else {
            continue;
        };
        if pool.tokens != venue.tokens || pool.reserves.len() != pool.tokens.len() {
            return Err(Skip::VenueMismatch);
        }
        if best.is_none_or(|(_, b, bi, _)| pool.reserves[i] > b.reserves[bi]) {
            best = Some((venue, pool, i, o));
        }
    }
    let (venue, pool, in_idx, out_idx) = best.ok_or(Skip::NoVenue)?;
    let (reserve_in, reserve_out) = (pool.reserves[in_idx], pool.reserves[out_idx]);

    let p_in = price_of(oracle, &sell.symbol, now, policy.max_oracle_age_secs)?;
    let p_out = price_of(oracle, &buy.symbol, now, policy.max_oracle_age_secs)?;

    let balance = vault.balances.get(&sell.token).copied().unwrap_or(0).max(0) as u128;
    if balance == 0 {
        return Err(Skip::NothingToSell);
    }

    // Rolling 24-hour window, exactly as the vault prunes it.
    let window: Vec<&TradeMark> = vault
        .recent
        .iter()
        .filter(|m| m.timestamp.saturating_add(WINDOW_SECS) > now)
        .collect();
    if window.len() as u32 >= policy.max_daily_trades {
        return Err(Skip::DailyTradeLimit);
    }
    let used_usd: i128 = window.iter().map(|m| m.usd).sum();
    let remaining_usd = policy.max_daily_usd.saturating_sub(used_usd);
    if remaining_usd <= 0 {
        return Err(Skip::DailyVolumeLimit);
    }

    let pool_cap = mul_div(reserve_in, cfg.max_pool_share_bps as u128, BPS)?
        .saturating_sub(used_in.get(&pool.pool).copied().unwrap_or(0));
    if pool_cap == 0 {
        return Err(Skip::PoolDepthExhausted);
    }

    let amount_in = [
        mul_div(balance, signal.size_bps as u128, BPS)?,
        mul_div(balance, policy.max_trade_bps as u128, BPS)?,
        amount_for_usd(
            policy.max_trade_usd.max(0) as u128,
            p_in,
            sell.decimals,
            oracle.decimals,
        )?,
        amount_for_usd(remaining_usd as u128, p_in, sell.decimals, oracle.decimals)?,
        pool_cap,
    ]
    .into_iter()
    .min()
    .unwrap_or(0);

    let usd = usd_value(amount_in, p_in, sell.decimals, oracle.decimals)?;
    if amount_in == 0 || usd < cfg.min_trade_usd {
        return Err(Skip::TooSmall);
    }

    let estimate = constant_product_out(amount_in, reserve_in, reserve_out, pool.fee_bps)?;
    let min_out = mul_div(estimate, BPS - cfg.slippage_bps as u128, BPS)?;
    if min_out == 0 {
        return Err(Skip::TooSmall);
    }
    let fair = fair_output(amount_in, p_in, p_out, sell.decimals, buy.decimals)?;
    let floor = mul_div(fair, BPS - policy.max_slippage_bps as u128, BPS)?;
    if min_out < floor {
        return Err(Skip::PoolOutsideOracleBand);
    }

    Ok(Plan {
        pool: venue.pool.clone(),
        token_in: sell.token,
        token_out: buy.token,
        in_idx: in_idx as u32,
        out_idx: out_idx as u32,
        amount_in,
        min_out,
        usd_value: usd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signal::tests::{entry_json, LEADER};

    const USDC: &str = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
    const XLM: &str = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const POOL: &str = "CDVB6O3WX24AAZ77SQRN52ABU4ECB66N36FG5BFVPTV54DPG3V6MOTOD";
    const ONE: i128 = 10_000_000;
    const NOW: u64 = 1_795_060_300;

    fn record() -> SignalRecordSnap {
        SignalRecordSnap {
            leader: LEADER.into(),
            seq: 1,
            ledger: 100,
            timestamp: NOW - 10,
        }
    }

    fn vault() -> VaultSnapshot {
        VaultSnapshot {
            vault: "CVAULT".into(),
            paused: false,
            policy: PolicySnap {
                leader: LEADER.into(),
                assets: vec![
                    AssetSnap {
                        token: USDC.into(),
                        symbol: "USDC".into(),
                        decimals: 7,
                    },
                    AssetSnap {
                        token: XLM.into(),
                        symbol: "XLM".into(),
                        decimals: 7,
                    },
                ],
                venues: vec![VenueSnap {
                    pool: POOL.into(),
                    tokens: vec![USDC.into(), XLM.into()],
                }],
                max_trade_bps: 5_000,
                max_trade_usd: 1_000 * ONE,
                max_daily_usd: 3_000 * ONE,
                max_daily_trades: 5,
                max_slippage_bps: 100,
                max_signal_age_secs: 3_600,
                max_oracle_age_secs: 900,
                expires_at: NOW + 86_400,
            },
            balances: BTreeMap::from([(USDC.into(), 2_000 * ONE), (XLM.into(), 0)]),
            recent: vec![],
            signal_used: false,
        }
    }

    /// 1,000,000 USDC / 7,142,857 XLM: priced at the oracle's 0.14.
    fn pools() -> Vec<PoolSnapshot> {
        vec![PoolSnapshot {
            pool: POOL.into(),
            tokens: vec![USDC.into(), XLM.into()],
            reserves: vec![(1_000_000 * ONE) as u128, (7_142_857 * ONE) as u128],
            fee_bps: 30,
        }]
    }

    fn oracle() -> OracleSnapshot {
        OracleSnapshot {
            decimals: 14,
            prices: BTreeMap::from([
                (
                    "USDC".into(),
                    PricePoint {
                        price: 100_000_000_000_000,
                        timestamp: NOW - 60,
                    },
                ),
                (
                    "XLM".into(),
                    PricePoint {
                        price: 14_000_000_000_000,
                        timestamp: NOW - 60,
                    },
                ),
            ]),
        }
    }

    fn plan(
        signal_json: &str,
        v: &VaultSnapshot,
        p: &[PoolSnapshot],
        o: &OracleSnapshot,
    ) -> Result<Plan, Skip> {
        let signal = Signal::parse(signal_json.as_bytes()).unwrap();
        plan_trade(
            &signal,
            &record(),
            v,
            p,
            o,
            NOW,
            &BTreeMap::new(),
            &SizingConfig::default(),
        )
    }

    #[test]
    fn sizes_an_entry_from_the_quote_balance() {
        let p = plan(&entry_json(2_500), &vault(), &pools(), &oracle()).unwrap();
        assert_eq!(p.amount_in, (500 * ONE) as u128); // 25% of 2,000 USDC
        assert_eq!((p.in_idx, p.out_idx), (0, 1));
        assert_eq!(p.usd_value, (500 * ONE) as u128);
        let estimate = constant_product_out(
            p.amount_in,
            (1_000_000 * ONE) as u128,
            (7_142_857 * ONE) as u128,
            30,
        )
        .unwrap();
        assert_eq!(p.min_out, estimate * 9_950 / 10_000);
    }

    #[test]
    fn caps_by_balance_share_usd_and_daily_volume() {
        // 100% requested, 50% share cap -> 1,000 USDC, also the USD cap.
        assert_eq!(
            plan(&entry_json(10_000), &vault(), &pools(), &oracle())
                .unwrap()
                .amount_in,
            (1_000 * ONE) as u128
        );

        let mut v = vault();
        v.recent = vec![TradeMark {
            timestamp: NOW - 100,
            usd: 2_800 * ONE,
        }];
        assert_eq!(
            plan(&entry_json(10_000), &v, &pools(), &oracle())
                .unwrap()
                .amount_in,
            (200 * ONE) as u128
        );

        v.recent = vec![TradeMark {
            timestamp: NOW - 100,
            usd: 3_000 * ONE,
        }];
        assert_eq!(
            plan(&entry_json(10_000), &v, &pools(), &oracle()),
            Err(Skip::DailyVolumeLimit)
        );

        // Trades older than a day no longer count.
        v.recent = vec![TradeMark {
            timestamp: NOW - 86_400,
            usd: 3_000 * ONE,
        }];
        assert!(plan(&entry_json(10_000), &v, &pools(), &oracle()).is_ok());
    }

    #[test]
    fn respects_the_daily_trade_count() {
        let mut v = vault();
        v.recent = (0..5)
            .map(|i| TradeMark {
                timestamp: NOW - 10 - i,
                usd: ONE,
            })
            .collect();
        assert_eq!(
            plan(&entry_json(100), &v, &pools(), &oracle()),
            Err(Skip::DailyTradeLimit)
        );
    }

    #[test]
    fn caps_total_size_per_signal_by_pool_depth() {
        let signal = Signal::parse(entry_json(10_000).as_bytes()).unwrap();
        let mut v = vault();
        v.balances.insert(USDC.into(), 1_000_000 * ONE);
        v.policy.max_trade_usd = 1_000_000 * ONE;
        v.policy.max_daily_usd = 1_000_000 * ONE;
        // Price impact of 5,000 USDC plus fee and slippage is ~1.3%: widen the
        // oracle band so this test isolates the depth cap.
        v.policy.max_slippage_bps = 300;
        // 2% of the 1,000,000 USDC reserve = 20,000 USDC, minus 15,000 already used.
        let used = BTreeMap::from([(POOL.to_string(), (15_000 * ONE) as u128)]);
        let p = plan_trade(
            &signal,
            &record(),
            &v,
            &pools(),
            &oracle(),
            NOW,
            &used,
            &SizingConfig::default(),
        );
        assert_eq!(p.unwrap().amount_in, (5_000 * ONE) as u128);

        let used = BTreeMap::from([(POOL.to_string(), (20_000 * ONE) as u128)]);
        let p = plan_trade(
            &signal,
            &record(),
            &v,
            &pools(),
            &oracle(),
            NOW,
            &used,
            &SizingConfig::default(),
        );
        assert_eq!(p, Err(Skip::PoolDepthExhausted));
    }

    #[test]
    fn skips_when_the_pool_is_far_from_the_oracle() {
        // Testnet reality: pool at 0.56 USDC/XLM while the oracle says 0.14.
        let mut p = pools();
        p[0].reserves = vec![(20_657 * ONE) as u128, (36_646 * ONE) as u128];
        assert_eq!(
            plan(&entry_json(2_500), &vault(), &p, &oracle()),
            Err(Skip::PoolOutsideOracleBand)
        );
    }

    #[test]
    fn plans_a_close_from_the_base_balance() {
        let close = format!(
            r#"{{"v":1,"kind":"close","leader":"{LEADER}","base":"XLM","quote":"USDC","size_bps":10000,"entry_ref":"{}","salt":"{}","ts":1795060600}}"#,
            "cd".repeat(32),
            "ef".repeat(32)
        );
        let mut v = vault();
        v.balances.insert(XLM.into(), 3_000 * ONE);
        let p = plan(&close, &v, &pools(), &oracle()).unwrap();
        assert_eq!((p.in_idx, p.out_idx), (1, 0));
        // 50% share cap of 3,000 XLM = 1,500 XLM = 210 USD.
        assert_eq!(p.amount_in, (1_500 * ONE) as u128);
        assert_eq!(p.usd_value, (210 * ONE) as u128);
    }

    #[test]
    fn skips_vaults_that_cannot_or_should_not_trade() {
        let s = entry_json(2_500);
        let mut v = vault();
        v.paused = true;
        assert_eq!(plan(&s, &v, &pools(), &oracle()), Err(Skip::Paused));

        let mut v = vault();
        v.policy.expires_at = NOW;
        assert_eq!(plan(&s, &v, &pools(), &oracle()), Err(Skip::Expired));

        let mut v = vault();
        v.policy.leader = "GOTHER".into();
        assert_eq!(plan(&s, &v, &pools(), &oracle()), Err(Skip::WrongLeader));

        let mut v = vault();
        v.signal_used = true;
        assert_eq!(plan(&s, &v, &pools(), &oracle()), Err(Skip::SignalUsed));

        let mut v = vault();
        v.policy.max_signal_age_secs = 30;
        assert_eq!(plan(&s, &v, &pools(), &oracle()), Err(Skip::SignalTooOld));

        let mut v = vault();
        v.balances.insert(USDC.into(), 0);
        assert_eq!(plan(&s, &v, &pools(), &oracle()), Err(Skip::NothingToSell));

        let mut v = vault();
        v.policy.assets.remove(1);
        assert_eq!(
            plan(&s, &v, &pools(), &oracle()),
            Err(Skip::AssetNotInPolicy("XLM".into()))
        );

        assert_eq!(plan(&s, &vault(), &[], &oracle()), Err(Skip::NoVenue));

        let mut p = pools();
        p[0].tokens.reverse();
        assert_eq!(plan(&s, &vault(), &p, &oracle()), Err(Skip::VenueMismatch));

        let mut o = oracle();
        o.prices.get_mut("XLM").unwrap().timestamp = NOW - 900;
        assert_eq!(
            plan(&s, &vault(), &pools(), &o),
            Err(Skip::OracleStale("XLM".into()))
        );

        let mut o = oracle();
        o.prices.remove("XLM");
        assert_eq!(
            plan(&s, &vault(), &pools(), &o),
            Err(Skip::OracleUnavailable("XLM".into()))
        );

        let mut v = vault();
        v.balances.insert(USDC.into(), ONE / 2);
        assert_eq!(
            plan(&entry_json(10_000), &v, &pools(), &oracle()),
            Err(Skip::TooSmall)
        );
    }

    #[test]
    fn usd_conversions_match_the_vault_and_never_overshoot() {
        assert_eq!(
            usd_value((100 * ONE) as u128, 14_000_000_000_000, 7, 14).unwrap(),
            (14 * ONE) as u128
        );
        for usd in [1u128, 7, 10_000_000, 123_456_789, 10_000_000_000] {
            let a = amount_for_usd(usd, 13_680_133_896_323, 7, 14).unwrap();
            assert!(usd_value(a, 13_680_133_896_323, 7, 14).unwrap() <= usd);
            assert!(usd_value(a + 1, 13_680_133_896_323, 7, 14).unwrap() > usd || a == 0);
        }
        assert_eq!(
            fair_output(
                (100 * ONE) as u128,
                100_000_000_000_000,
                14_000_000_000_000,
                7,
                7
            )
            .unwrap(),
            7_142_857_142
        );
    }

    #[test]
    fn constant_product_matches_a_live_aquarius_quote() {
        // Testnet pool CAYBMZYJ…: estimate_swap(1 -> 0, 10 XLM) returned 69,267,878.
        let out =
            constant_product_out(100_000_000, 26_160_532_488_582, 18_175_441_355_403, 30).unwrap();
        assert!(out.abs_diff(69_267_878) <= 2, "{out}");
    }
}
