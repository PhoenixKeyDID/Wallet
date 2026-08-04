/**
 * CIP-1694 / Conway on-chain governance for the browser wallet — pure JS via
 * @stricahq/typhonjs. Four flows, mirroring Lace's Governance tab:
 *
 *   1. Delegate voting power to a dRep  (VOTE_DELEGATION cert; also the special
 *      Abstain / No-Confidence pseudo-dReps).                       ← CIP-30 ready
 *   2. Vote Yes/No/Abstain on a Governance Action  (voting procedure). ← needs dRep key
 *   3. Register / de-register as a dRep  (DREP_REG / DREP_DE_REG).     ← needs dRep key
 *   4. Submit a Governance Action  (proposal procedure).              ← CIP-30 ready
 *
 * ⚠️ EXPERIMENTAL / UNAUDITED. Moves value (deposits). Two-step review in the
 * panel + throwaway-preprod testing before trusting it. See tx.ts header.
 *
 * KEY-CONTROL CONSTRAINT (read `hard-constraint` in the build report):
 *  - Vote-delegation needs only the STAKE credential, which the connected wallet
 *    controls via its reward address (`getRewardAddresses()`), so it is fully
 *    buildable + signable over plain CIP-30.
 *  - Registering as a dRep and voting AS a dRep need the account's dRep
 *    credential (CIP-1852 role 3). Plain CIP-30 does NOT expose it. A CIP-95
 *    wallet exposes `getPubDRepKey()`; otherwise supply the dRep key-hash from
 *    the watch/xpub path (`keyHashAt(xvk, 3, index)`). We never fabricate a key
 *    the wallet cannot sign — the caller must pass a real `drepKeyHash`.
 */
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import {
  Transaction,
  utils as tyUtils,
  types as tyTypes,
  address as tyAddress,
} from "@stricahq/typhonjs";
import type { PhoenixNetwork } from "./address";
import { koios } from "./provider";
import type { BuiltTx } from "./tx";

type Input = tyTypes.Input;
type Token = tyTypes.Token;
type ProtocolParams = tyTypes.ProtocolParams;
type CardanoAddress = tyTypes.CardanoAddress;
type RewardAddress = tyAddress.RewardAddress;
type DRep = tyTypes.DRep;
type Anchor = tyTypes.Anchor;
type Voter = tyTypes.Voter;
type GovActionId = tyTypes.GovActionId;
type GovAction = tyTypes.GovAction;
type VotingProcedure = tyTypes.VotingProcedure;
type ProposalProcedure = tyTypes.ProposalProcedure;
type Certificate = tyTypes.Certificate;

// ─── Shared build context ─────────────────────────────────────────────────────

/** Everything a builder needs beyond its own semantic args. */
export type GovBuildCtx = {
  inputs: Input[];
  protocolParams: ProtocolParams;
  changeAddress: CardanoAddress;
  ttl: number;
};

function toBuilt(prepared: Transaction): BuiltTx {
  const built = prepared.buildTransaction();
  return {
    transaction: prepared,
    unsignedCbor: built.payload,
    hash: built.hash,
    fee: prepared.getFee().toString(),
  };
}

// ─── dRep id parsing (CIP-105 legacy + CIP-129) ───────────────────────────────

export type DRepCred = { hash: Buffer; isScript: boolean };

/**
 * Parse a dRep id into its 28-byte credential hash + key/script flag.
 * Accepts:
 *  - CIP-129 bech32 `drep1…` (29 bytes: 1 header + 28 hash; header low-nibble
 *    0x2 = key, 0x3 = script).
 *  - CIP-105 legacy bech32 `drep1…` / `drep_script1…` (28-byte hash; the prefix
 *    disambiguates key vs script).
 *  - a bare 56-char hex key-hash (assumed key credential).
 */
export function parseDRepId(drepId: string): DRepCred {
  const s = drepId.trim();
  if (/^[0-9a-fA-F]{56}$/.test(s)) {
    return { hash: Buffer.from(s, "hex"), isScript: false };
  }
  const { prefix, value } = tyUtils.decodeBech32(s);
  const bytes = Buffer.from(value);
  if (bytes.length === 29) {
    const credType = bytes[0] & 0x0f; // 0x2 key-hash, 0x3 script-hash
    // Reject any other credential type rather than silently treating it as a
    // key hash — an unknown header must fail loudly, not delegate to the wrong
    // credential kind.
    if (credType !== 0x2 && credType !== 0x3) {
      throw new Error(`unrecognised dRep id credential type 0x${credType.toString(16)}`);
    }
    return { hash: bytes.subarray(1), isScript: credType === 0x3 };
  }
  if (bytes.length === 28) {
    return { hash: bytes, isScript: prefix === "drep_script" };
  }
  throw new Error(`unrecognised dRep id (length ${bytes.length})`);
}

/** Parse a governance-action id `txHash#index` → typhon `GovActionId`. */
export function parseGovActionId(id: string): GovActionId {
  const [txHash, indexStr, ...rest] = id.trim().split("#");
  if (rest.length > 0) throw new Error("gov action id has too many '#'");
  if (!/^[0-9a-fA-F]{64}$/.test(txHash ?? "")) {
    throw new Error("gov action id: tx hash must be 64 hex chars");
  }
  const index = Number(indexStr);
  if (!Number.isInteger(index) || index < 0 || String(index) !== indexStr) {
    throw new Error("gov action id: index must be a non-negative integer");
  }
  return { txId: Buffer.from(txHash, "hex"), index };
}

// ─── Credential helpers ───────────────────────────────────────────────────────

function keyHashCredential(hash: Buffer): tyTypes.HashCredential {
  return { hash, type: tyTypes.HashType.ADDRESS };
}
function scriptHashCredential(hash: Buffer): tyTypes.ScriptCredential {
  return { hash, type: tyTypes.HashType.SCRIPT };
}
function credentialFrom(cred: DRepCred): tyTypes.Credential {
  return cred.isScript ? scriptHashCredential(cred.hash) : keyHashCredential(cred.hash);
}

/** A `RewardAddress` from either its CIP-30 hex form or a bech32 `stake…`. */
export function rewardAddressFrom(hexOrBech32: string): RewardAddress {
  const s = hexOrBech32.trim();
  const addr = /^(stake|stake_test)1/.test(s)
    ? tyUtils.getAddressFromString(s)
    : tyUtils.getAddressFromHex(Buffer.from(s, "hex"));
  if (!(addr instanceof tyAddress.RewardAddress)) {
    throw new Error("expected a reward (stake) address");
  }
  return addr;
}

// ─── Pure structure builders (unit-tested directly) ───────────────────────────

/** The delegation target: a real dRep, or one of the two special pseudo-dReps. */
export type DelegationTarget =
  | { kind: "drep"; drepId: string }
  | { kind: "abstain" }
  | { kind: "noConfidence" };

/** Map a delegation target → typhon `DRep` (correct `DRepType` + key). */
export function dRepFromTarget(target: DelegationTarget): DRep {
  switch (target.kind) {
    case "abstain":
      return { type: tyTypes.DRepType.ABSTAIN, key: undefined };
    case "noConfidence":
      return { type: tyTypes.DRepType.NO_CONFIDENCE, key: undefined };
    case "drep": {
      const cred = parseDRepId(target.drepId);
      return {
        type: cred.isScript ? tyTypes.DRepType.SCRIPT : tyTypes.DRepType.ADDRESS,
        key: cred.hash,
      };
    }
  }
}

/** VOTE_DELEGATION certificate for a stake credential → dRep target. */
export function voteDelegationCert(
  stakeCredential: tyTypes.StakeCredential,
  target: DelegationTarget,
): tyTypes.VoteDelegationCertificate {
  return {
    type: tyTypes.CertificateType.VOTE_DELEGATION,
    cert: { stakeCredential, dRep: dRepFromTarget(target) },
  };
}

/** DREP_REG certificate. `anchor` optional (metadata url + 32-byte hash). */
export function drepRegCert(
  drepCred: DRepCred,
  deposit: BigNumber,
  anchor?: Anchor | null,
): tyTypes.DRepRegCertificate {
  return {
    type: tyTypes.CertificateType.DREP_REG,
    cert: { dRepCredential: credentialFrom(drepCred), deposit, anchor: anchor ?? null },
  };
}

/** DREP_DE_REG certificate (reclaims the deposit). */
export function drepDeRegCert(
  drepCred: DRepCred,
  deposit: BigNumber,
): tyTypes.DRepDeRegCertificate {
  return {
    type: tyTypes.CertificateType.DREP_DE_REG,
    cert: { dRepCredential: credentialFrom(drepCred), deposit },
  };
}

/** A `Voter` from a dRep credential (key or script role). */
export function dRepVoter(cred: DRepCred): Voter {
  return {
    type: cred.isScript ? tyTypes.VoterType.DREP_SCRIPT : tyTypes.VoterType.DREP_KEY,
    key: credentialFrom(cred),
  };
}

/** A single voting procedure: one voter casts one vote on one gov action. */
export function voteProcedure(
  voter: Voter,
  govActionId: GovActionId,
  vote: tyTypes.VoteType,
  anchor?: Anchor | null,
): VotingProcedure {
  return { voter, votes: [{ govActionId, vote, anchor: anchor ?? null }] };
}

// ── Governance-action shapes (for proposals) ──

/** Info action — a signalling proposal with no on-chain effect. */
export function infoAction(): GovAction {
  return { type: tyTypes.GovActionType.INFO_ACTION };
}

/** Treasury-withdrawal action: pay `amount` lovelace to a reward account. */
export function treasuryWithdrawalAction(
  withdrawals: Array<{ rewardAccount: RewardAddress; amount: BigNumber }>,
  policyHash: Buffer | null = null,
): GovAction {
  return {
    type: tyTypes.GovActionType.TREASURY_WITHDRAW_ACTION,
    action: { withdrawals, policyHash },
  };
}

/** Proposal procedure: deposit + return account + the action + its anchor. */
export function proposalProcedure(
  deposit: BigNumber,
  rewardAccount: RewardAddress,
  govAction: GovAction,
  anchor: Anchor,
): ProposalProcedure {
  return { deposit, rewardAccount: rewardAccount.getBytes(), govAction, anchor };
}

// ─── Token aggregation (manual-balance path) ──────────────────────────────────

function aggregateTokens(inputs: Input[]): Token[] {
  const byUnit = new Map<string, Token>();
  for (const inp of inputs) {
    for (const tk of inp.tokens) {
      const unit = tk.policyId + tk.assetName;
      const prev = byUnit.get(unit);
      byUnit.set(unit, {
        policyId: tk.policyId,
        assetName: tk.assetName,
        amount: (prev?.amount ?? new BigNumber(0)).plus(tk.amount),
      });
    }
  }
  return [...byUnit.values()];
}

function sumAda(inputs: Input[]): BigNumber {
  return inputs.reduce((acc, i) => acc.plus(i.amount), new BigNumber(0));
}

// ─── Tx builders ──────────────────────────────────────────────────────────────

/**
 * Build a vote-delegation tx. `rewardAddress` is the connected wallet's reward
 * address (it controls this stake key and will sign). Uses the library's
 * `prepareTransaction` (no deposit involved → library balances correctly).
 */
export function buildVoteDelegation(
  args: { rewardAddress: RewardAddress; target: DelegationTarget } & GovBuildCtx,
): BuiltTx {
  const cert = voteDelegationCert(args.rewardAddress.stakeCredential, args.target);
  const tx = new Transaction({ protocolParams: args.protocolParams });
  tx.setTTL(args.ttl);
  tx.addCertificate(cert);
  const prepared = tx.prepareTransaction({
    inputs: args.inputs,
    changeAddress: args.changeAddress,
  });
  return toBuilt(prepared);
}

/**
 * Build a vote (Yes/No/Abstain) on a gov action, cast by the dRep the wallet
 * controls. No deposit → `prepareTransaction`. NOTE: signable only if the wallet
 * can produce a witness for `voterCred` (CIP-95 dRep key). See module header.
 */
export function buildVote(
  args: {
    voter: DRepCred;
    govActionId: GovActionId;
    vote: tyTypes.VoteType;
    anchor?: Anchor | null;
  } & GovBuildCtx,
): BuiltTx {
  const procedure = voteProcedure(
    dRepVoter(args.voter),
    args.govActionId,
    args.vote,
    args.anchor ?? null,
  );
  const tx = new Transaction({ protocolParams: args.protocolParams });
  tx.setTTL(args.ttl);
  tx.addVotingProcedure(procedure);
  const prepared = tx.prepareTransaction({
    inputs: args.inputs,
    changeAddress: args.changeAddress,
  });
  return toBuilt(prepared);
}

/**
 * Build a proposal-submission tx. The proposal deposit IS accounted by typhon's
 * `getAdditionalOutputAda`, so `prepareTransaction` balances it correctly.
 */
export function buildProposal(
  args: {
    deposit: BigNumber;
    rewardAccount: RewardAddress;
    govAction: GovAction;
    anchor: Anchor;
  } & GovBuildCtx,
): BuiltTx {
  const procedure = proposalProcedure(
    args.deposit,
    args.rewardAccount,
    args.govAction,
    args.anchor,
  );
  const tx = new Transaction({ protocolParams: args.protocolParams });
  tx.setTTL(args.ttl);
  tx.addProposalProcedure(procedure);
  const prepared = tx.prepareTransaction({
    inputs: args.inputs,
    changeAddress: args.changeAddress,
  });
  return toBuilt(prepared);
}

/**
 * Balance a certificate-only tx by hand, applying a deposit delta the library
 * ignores. `depositDelta` is ADDED to the produced side:
 *   +deposit  for DREP_REG    (we must fund the deposit),
 *   −deposit  for DREP_DE_REG (the deposit is refunded to us).
 *
 * WHY manual: typhon's `prepareTransaction` does not reserve the DREP_REG
 * deposit nor credit the DREP_DE_REG refund (verified: `getAdditionalOutputAda`
 * / `getAdditionalInputAda` handle only stake certs + proposals). Left to
 * `prepareTransaction`, the tx would be unbalanced by exactly the deposit. We
 * therefore select ALL provided inputs, return one change output carrying every
 * leftover token, and set change = Σinputs − fee − depositDelta.
 */
/**
 * Extra vkey-witness the input-derived fee estimate can miss on this path.
 * DREP_REG / DREP_DE_REG / vote require a witness for the dRep (CIP-1852 role-3)
 * key, which is tied to NO input — so typhon, which sizes the witness set from
 * the inputs' credentials, can under-count by one witness and produce a fee that
 * the node rejects with FeeTooSmall (a liveness failure, never a loss). A vkey
 * witness is ~101 bytes on the wire (32-byte key + 64-byte sig + CBOR framing);
 * we add minFeeA·101 as a floor so the tx can never go out under the true
 * minimum. The over-estimate is ≤ ~0.005 ADA and comes back as change.
 * TODO(preprod): confirm the exact witness count against a live DREP_REG/vote
 * submit before enabling dRep registration/voting on mainnet.
 */
const EXTRA_WITNESS_BYTES = 101;

function buildCertOnlyTxManualBalance(
  cert: Certificate,
  depositDelta: BigNumber,
  ctx: GovBuildCtx,
): BuiltTx {
  if (ctx.inputs.length === 0) throw new Error("no inputs to build governance tx");
  const tx = new Transaction({ protocolParams: ctx.protocolParams });
  tx.setTTL(ctx.ttl);
  tx.addCertificate(cert);
  for (const inp of ctx.inputs) tx.addInput(inp);

  const totalAda = sumAda(ctx.inputs);
  const tokens = aggregateTokens(ctx.inputs);
  // Single change output back to the wallet, carrying all native tokens.
  const changeOutput: tyTypes.Output = {
    address: ctx.changeAddress,
    amount: totalAda.minus(depositDelta),
    tokens,
  };
  tx.addOutput(changeOutput); // typhon stores this exact object ref (we mutate below)

  // Fee measurement: DO NOT zero the fee first. typhon's constructor seeds
  // `this.fee = 5_000_000` as a placeholder so the encoded fee field is a full
  // 5-byte CBOR uint — the same width as any real governance fee (always
  // > 65536). Forcing it to 0 shrinks the measured body by 4 bytes, so the
  // measured fee comes out 4·minFeeA (=176 lovelace) short and the node rejects
  // with FeeTooSmall. Leaving the wide placeholder in place keeps the measured
  // size equal to the built size. Two passes converge (change width is stable).
  // Add a one-witness floor (see EXTRA_WITNESS_BYTES) to the measured fee so the
  // cert's dRep-key witness is always paid for even if the estimator misses it.
  const witnessMargin = ctx.protocolParams.minFeeA.multipliedBy(EXTRA_WITNESS_BYTES);
  let fee = tx.calculateFee().plus(witnessMargin);
  changeOutput.amount = totalAda.minus(depositDelta).minus(fee);
  fee = tx.calculateFee().plus(witnessMargin);
  changeOutput.amount = totalAda.minus(depositDelta).minus(fee);
  tx.setFee(fee);

  // Belt-and-braces: re-measure with the real fee set; if the width somehow
  // grew, absorb the increase from change so we never submit under the min fee.
  const finalFee = tx.calculateFee().plus(witnessMargin);
  if (finalFee.isGreaterThan(fee)) {
    changeOutput.amount = changeOutput.amount.minus(finalFee.minus(fee));
    tx.setFee(finalFee);
    fee = finalFee;
  }

  if (changeOutput.amount.isNegative()) {
    throw new Error("insufficient funds to cover the deposit and fee");
  }
  const minUtxo = tx.calculateMinUtxoAmountBabbage(changeOutput);
  if (changeOutput.amount.isLessThan(minUtxo)) {
    throw new Error("change below minimum UTxO after deposit and fee");
  }
  const built = tx.buildTransaction();
  return {
    transaction: tx,
    unsignedCbor: built.payload,
    hash: built.hash,
    fee: tx.getFee().toString(),
  };
}

/**
 * Register as a dRep. `drepKeyHash` = the wallet's role-3 dRep key hash (see
 * module header — not exposed by plain CIP-30; needs CIP-95 or the xpub path).
 * `deposit` = the `dRepDeposit` protocol param (Koios: `drep_deposit`).
 */
export function buildDRepRegistration(
  args: { drepKeyHash: Buffer; deposit: BigNumber; anchor?: Anchor | null } & GovBuildCtx,
): BuiltTx {
  const cert = drepRegCert({ hash: args.drepKeyHash, isScript: false }, args.deposit, args.anchor);
  return buildCertOnlyTxManualBalance(cert, args.deposit, args);
}

/** De-register a dRep and reclaim the deposit (credited back into change). */
export function buildDRepDeRegistration(
  args: { drepKeyHash: Buffer; deposit: BigNumber } & GovBuildCtx,
): BuiltTx {
  const cert = drepDeRegCert({ hash: args.drepKeyHash, isScript: false }, args.deposit);
  return buildCertOnlyTxManualBalance(cert, args.deposit.negated(), args);
}

// ─── Koios reads ──────────────────────────────────────────────────────────────

export type DRepSummary = {
  drepId: string;
  hex: string;
  isScript: boolean;
  registered: boolean;
  /** live delegated stake in lovelace (string; from `/drep_info.amount`). */
  votingPower?: string;
  active?: boolean;
  expiresEpoch?: number;
  metaUrl?: string;
  metaHash?: string;
};

type KoiosDRepListRow = { drep_id: string; hex: string; has_script: boolean; registered: boolean };
type KoiosDRepInfoRow = KoiosDRepListRow & {
  deposit: string | null;
  active: boolean;
  expires_epoch_no: number | null;
  amount: string | null;
  meta_url: string | null;
  meta_hash: string | null;
};

/**
 * List dReps. Fetches `/drep_list`, optionally filters by id substring, then
 * enriches up to `limit` matches with `/drep_info` (voting power + anchor).
 * The two special options (Abstain / No-Confidence) are UI-only, not returned.
 */
export async function listDReps(
  network: PhoenixNetwork,
  query?: string,
  limit = 20,
): Promise<DRepSummary[]> {
  const list = await koios<KoiosDRepListRow[]>(network, "/drep_list");
  const q = query?.trim().toLowerCase();
  const filtered = (q ? list.filter((d) => d.drep_id.toLowerCase().includes(q)) : list)
    .filter((d) => d.registered)
    .slice(0, limit);
  if (filtered.length === 0) return [];

  // Throws on failure rather than falling back to `[]`. An empty info set makes
  // every dRep render with no voting power and no anchor — indistinguishable
  // from real dReps that hold nothing, right where the user is choosing whom to
  // delegate their vote to.
  const info = await koios<KoiosDRepInfoRow[]>(network, "/drep_info", {
    _drep_ids: filtered.map((d) => d.drep_id),
  });
  const byId = new Map(info.map((i) => [i.drep_id, i]));
  return filtered.map((d) => {
    const i = byId.get(d.drep_id);
    return {
      drepId: d.drep_id,
      hex: d.hex,
      isScript: d.has_script,
      registered: d.registered,
      votingPower: i?.amount ?? undefined,
      active: i?.active,
      expiresEpoch: i?.expires_epoch_no ?? undefined,
      metaUrl: i?.meta_url ?? undefined,
      metaHash: i?.meta_hash ?? undefined,
    };
  });
}

export type GovActionSummary = {
  /** `txHash#index` — feed straight into `parseGovActionId`. */
  id: string;
  proposalId: string;
  type: string;
  title?: string;
  abstract?: string;
  expiration?: number;
  isOpen: boolean;
};

type KoiosProposalRow = {
  proposal_id: string;
  proposal_tx_hash: string;
  proposal_index: number;
  proposal_type: string;
  expiration: number | null;
  ratified_epoch: number | null;
  enacted_epoch: number | null;
  dropped_epoch: number | null;
  expired_epoch: number | null;
  meta_json: { body?: { title?: string; abstract?: string } } | null;
};

/**
 * List governance actions from `/proposal_list`. `isOpen` = not yet ratified /
 * enacted / dropped / expired (i.e. still votable). Title/abstract come from the
 * CIP-108 anchor metadata Koios already resolved into `meta_json.body`.
 */
export async function listGovActions(network: PhoenixNetwork): Promise<GovActionSummary[]> {
  const rows = await koios<KoiosProposalRow[]>(network, "/proposal_list");
  return rows.map((r) => {
    const isOpen =
      r.ratified_epoch == null &&
      r.enacted_epoch == null &&
      r.dropped_epoch == null &&
      r.expired_epoch == null;
    return {
      id: `${r.proposal_tx_hash}#${r.proposal_index}`,
      proposalId: r.proposal_id,
      type: r.proposal_type,
      title: r.meta_json?.body?.title,
      abstract: r.meta_json?.body?.abstract,
      expiration: r.expiration ?? undefined,
      isOpen,
    };
  });
}

export type VoteDelegationState = {
  found: boolean;
  status?: string;
  /** the dRep id currently delegated to, or a special label, or null. */
  delegatedDRep?: string | null;
};

type KoiosAccountInfoRow = {
  stake_address: string;
  status: string;
  delegated_drep: string | null;
};

/** Current vote-delegation for a reward (stake) address, via `/account_info`. */
export async function getVoteDelegationState(
  network: PhoenixNetwork,
  rewardAddressBech32: string,
): Promise<VoteDelegationState> {
  const rows = await koios<KoiosAccountInfoRow[]>(network, "/account_info", {
    _stake_addresses: [rewardAddressBech32],
  });
  const row = rows[0];
  if (!row) return { found: false };
  return { found: true, status: row.status, delegatedDRep: row.delegated_drep };
}

/**
 * Build an `Anchor` from a metadata URL and its 32-byte blake2b-256 hash (hex).
 * The caller computes the hash over the exact bytes served at `url`.
 */
export function makeAnchor(url: string, hashHex: string): Anchor {
  const u = url.trim();
  // CIP-108: the anchor url is a CBOR text string capped at 128 bytes and must
  // be a resolvable URI. Reject over-long or non-http(s)/ipfs urls up front, so
  // a bad anchor fails here with a clear message instead of at node submission.
  if (u.length === 0) throw new Error("anchor url must not be empty");
  if (Buffer.byteLength(u, "utf8") > 128) throw new Error("anchor url must be at most 128 bytes");
  if (!/^(https?|ipfs):\/\//i.test(u)) {
    throw new Error("anchor url must be an http(s) or ipfs URI");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hashHex)) {
    throw new Error("anchor hash must be 32 bytes (64 hex chars)");
  }
  return { url: u, hash: Buffer.from(hashHex, "hex") };
}
