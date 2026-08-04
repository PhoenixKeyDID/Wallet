/**
 * Staking — pool search, delegation, and reward withdrawal (pure JS via
 * @stricahq/typhonjs). Same "review before sign" contract as `tx.ts`: this
 * module only assembles unsigned transactions; the connected CIP-30 extension
 * holds the stake key and signs.
 *
 * Native Cardano delegates ONE stake key to ONE pool at a time — see the
 * MULTI-POOL note in the panel/report for why "Lace-style" multi-pool
 * delegation (multiple stake keys, one per pool) is out of scope for a single
 * connected CIP-30 account.
 *
 * ⚠️ EXPERIMENTAL / UNAUDITED, same caveat as `tx.ts`.
 */
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { Transaction, address as tyAddress, types as tyTypes, utils as tyUtils } from "@stricahq/typhonjs";
import { koios, type PhoenixNetwork, type BuiltTx } from "@/lib/cardano";

type RewardAddress = InstanceType<typeof tyAddress.RewardAddress>;

// ─── Reward-address / pool-id credential helpers ──────────────────────────────

/**
 * Parse a CIP-30 `getRewardAddresses()[0]` hex string into a typhon
 * `RewardAddress`. This is the stake key credential the connected wallet
 * actually controls and will sign for — never invent a stake key.
 */
export function rewardAddressFromHex(hex: string): RewardAddress {
  const addr = tyUtils.getAddressFromHex(Buffer.from(hex, "hex"));
  if (!(addr instanceof tyAddress.RewardAddress)) {
    throw new Error("Not a reward (stake) address");
  }
  return addr;
}

/** bech32 `pool1...` → 28-byte pool key hash (hex), the shape `StakeDelegationCertificate.cert.poolHash` expects. */
export function poolHashFromBech32(poolId: string): string {
  const { prefix, value } = tyUtils.decodeBech32(poolId.trim());
  if (prefix !== "pool") throw new Error(`Not a pool id: "${poolId}"`);
  if (value.length !== 28) throw new Error(`Unexpected pool hash length: ${value.length} bytes`);
  return value.toString("hex");
}

// ─── Koios reads ───────────────────────────────────────────────────────────────

export type PoolSummary = {
  poolId: string;
  ticker: string;
  name: string;
  liveStakeLovelace: bigint;
  saturationPct: number;
  marginPct: number;
  fixedCostLovelace: bigint;
  pledgeLovelace: bigint;
};

type PoolListRow = { pool_id_bech32?: string; pool_status?: string };
type PoolInfoRow = {
  pool_id_bech32: string;
  ticker?: string | null;
  pool_status?: string;
  meta_json?: { ticker?: string | null; name?: string | null } | null;
  live_stake?: string | null;
  live_saturation?: string | number | null;
  margin?: number | null;
  fixed_cost?: string | null;
  pledge?: string | null;
};

const POOL_INFO_CHUNK = 50;
// Cap how many candidate pools we fetch full detail for per search — Koios
// serves 1000s of pools and this module has no server-side index to filter
// by ticker/name before calling /pool_info. Good enough for "find a pool by
// ticker/name substring"; a backend search index is future work.
const MAX_CANDIDATES = 800;

/**
 * Search registered pools by ticker/name substring. Koios `/pool_list` has no
 * ticker field, so this fetches candidate ids, then `/pool_info` in batches
 * for the metadata to filter on. Empty query → no results (avoid fetching
 * everything just to show it unfiltered). Network failures are swallowed —
 * returns whatever was gathered before the failure, or `[]`.
 */
export async function searchPools(network: PhoenixNetwork, query: string): Promise<PoolSummary[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  let list: PoolListRow[];
  try {
    list = await koios<PoolListRow[]>(network, "/pool_list");
  } catch {
    return [];
  }
  const ids = list
    .filter((p) => !p.pool_status || p.pool_status === "registered")
    .map((p) => p.pool_id_bech32)
    .filter((id): id is string => Boolean(id))
    .slice(0, MAX_CANDIDATES);
  if (ids.length === 0) return [];

  const results: PoolSummary[] = [];
  for (let i = 0; i < ids.length; i += POOL_INFO_CHUNK) {
    const batch = ids.slice(i, i + POOL_INFO_CHUNK);
    let rows: PoolInfoRow[];
    try {
      rows = await koios<PoolInfoRow[]>(network, "/pool_info", { _pool_bech32_ids: batch });
    } catch {
      continue; // one flaky batch shouldn't blank the whole search
    }
    for (const r of rows) {
      if (r.pool_status && r.pool_status !== "registered") continue;
      const ticker = r.ticker ?? r.meta_json?.ticker ?? "";
      const name = r.meta_json?.name ?? "";
      if (!ticker.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue;
      results.push({
        poolId: r.pool_id_bech32,
        ticker,
        name,
        liveStakeLovelace: BigInt(r.live_stake ?? "0"),
        saturationPct: Number(r.live_saturation ?? 0) * 100,
        marginPct: Number(r.margin ?? 0) * 100,
        fixedCostLovelace: BigInt(r.fixed_cost ?? "0"),
        pledgeLovelace: BigInt(r.pledge ?? "0"),
      });
    }
  }
  return results;
}

export type StakeAccountState = {
  registered: boolean;
  delegatedPoolId: string | null;
  rewardsAvailable: bigint;
};

type AccountInfoRow = {
  stake_address?: string;
  status?: string; // "registered" | "not registered"
  delegated_pool?: string | null;
  rewards_available?: string | null;
};

/** Registration / delegation / claimable-rewards state of one reward address. */
export async function getStakeAccountState(
  network: PhoenixNetwork,
  rewardAddressBech32: string,
): Promise<StakeAccountState> {
  try {
    const rows = await koios<AccountInfoRow[]>(network, "/account_info", {
      _stake_addresses: [rewardAddressBech32],
    });
    const r = rows[0];
    if (!r) return { registered: false, delegatedPoolId: null, rewardsAvailable: BigInt("0") };
    return {
      registered: r.status === "registered",
      delegatedPoolId: r.delegated_pool ?? null,
      rewardsAvailable: BigInt(r.rewards_available ?? "0"),
    };
  } catch {
    return { registered: false, delegatedPoolId: null, rewardsAvailable: BigInt("0") };
  }
}

// ─── Builders ───────────────────────────────────────────────────────────────

export type BuildDelegationParams = {
  /** hex, from `api.getRewardAddresses()[0]` — the wallet's own stake key, never invented. */
  rewardAddress: string;
  /** bech32 `pool1...`. */
  poolId: string;
  /** true when the stake key has never been registered (Koios `account_info.status !== "registered"`). */
  needsRegistration: boolean;
  inputs: tyTypes.Input[];
  changeAddress: tyTypes.ShelleyAddress;
  protocolParams: tyTypes.ProtocolParams;
  tip: number;
};

/**
 * Build a delegation tx: optional stake-key registration certificate (only
 * when `needsRegistration`) followed by a stake-delegation certificate to
 * `poolId`.
 */
export function buildDelegation(params: BuildDelegationParams): BuiltTx {
  const { rewardAddress, poolId, needsRegistration, inputs, changeAddress, protocolParams, tip } = params;
  const stakeCredential = rewardAddressFromHex(rewardAddress).stakeCredential;
  const poolHash = poolHashFromBech32(poolId);

  const tx = new Transaction({ protocolParams });
  tx.setTTL(tip + 7200);

  if (needsRegistration) {
    const regCert: tyTypes.StakeKeyRegistrationCertificate = {
      type: tyTypes.CertificateType.STAKE_KEY_REGISTRATION,
      cert: { stakeCredential, deposit: protocolParams.stakeKeyDeposit },
    };
    tx.addCertificate(regCert);
  }

  const delegCert: tyTypes.StakeDelegationCertificate = {
    type: tyTypes.CertificateType.STAKE_DELEGATION,
    cert: { stakeCredential, poolHash },
  };
  tx.addCertificate(delegCert);

  const prepared = tx.prepareTransaction({ inputs, changeAddress });
  const built = prepared.buildTransaction();
  return { transaction: prepared, unsignedCbor: built.payload, hash: built.hash, fee: prepared.getFee().toString() };
}

export type BuildWithdrawalParams = {
  /** hex, from `api.getRewardAddresses()[0]`. */
  rewardAddress: string;
  /** lovelace — must be the full claimable balance (Cardano requires a full withdrawal). */
  amount: bigint;
  inputs: tyTypes.Input[];
  changeAddress: tyTypes.ShelleyAddress;
  protocolParams: tyTypes.ProtocolParams;
  tip: number;
};

/** Build a reward-withdrawal tx. */
export function buildWithdrawal(params: BuildWithdrawalParams): BuiltTx {
  const { rewardAddress, amount, inputs, changeAddress, protocolParams, tip } = params;
  if (amount <= BigInt("0")) throw new Error("Withdrawal amount must be greater than zero");
  const rewardAccount = rewardAddressFromHex(rewardAddress);

  const tx = new Transaction({ protocolParams });
  tx.setTTL(tip + 7200);
  tx.addWithdrawal({ rewardAccount, amount: new BigNumber(amount.toString()) });

  const prepared = tx.prepareTransaction({ inputs, changeAddress });
  const built = prepared.buildTransaction();
  return { transaction: prepared, unsignedCbor: built.payload, hash: built.hash, fee: prepared.getFee().toString() };
}
