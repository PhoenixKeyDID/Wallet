/**
 * CIP-1852 key derivation for a locally-held wallet.
 *
 *     m / 1852' / 1815' / account' / role / index
 *     role: 0 external payment · 1 internal change · 2 stake · 3 dRep
 *
 * Every step above `role` is **hardened**, and that is the whole security
 * argument for holding keys here at all. Soft (`CKDpub`) derivation is
 * invertible in the private direction — the account extended *public* key plus
 * the private key of any one soft child gives the account private key back, and
 * with it every address the account will ever have. Hardening the path down to
 * the account means a leaked child key stays a leaked child key.
 *
 * That is also why this module is separate from `../cardano/xpub.ts`. That one
 * does soft derivation on purpose, because watch-only mode only ever holds
 * public material. The two must never be confused, so they do not share code.
 */
import "../node-globals";
import { Buffer } from "buffer";
import { Bip32PrivateKey, PrivateKey } from "@stricahq/bip32ed25519";
import { baseAddress, rewardAddress, type PhoenixNetwork } from "../cardano/address";

const PURPOSE = 1852;
const COIN_TYPE = 1815;

export const ROLE = {
  external: 0,
  internal: 1,
  stake: 2,
  drep: 3,
} as const;

/**
 * How many addresses of each role to materialise.
 *
 * BIP-44 sets the gap limit at 20: a wallet scanning for used addresses stops
 * after 20 unused ones in a row. Deriving the same 20 means a wallet restored
 * here finds the same funds any other BIP-44 wallet would, and — more to the
 * point for signing — that we hold a key for every input a restored wallet can
 * legitimately be asked to spend.
 */
export const GAP_LIMIT = 20;

export type DerivedAddress = {
  /** `1852'/1815'/a'/role/index`, shown in the UI so a path can be checked. */
  path: string;
  role: number;
  index: number;
  /** Payment key hash, hex. */
  keyHashHex: string;
  /** bech32 base address (payment + this account's stake credential). */
  address: string;
};

/**
 * An account with its private keys live in memory.
 *
 * `keyByHash` is the piece that actually matters at signing time: the
 * transaction builder reports which key hashes it needs a witness from, and
 * this map answers. Nothing signs by guessing.
 */
export type Account = {
  accountIndex: number;
  network: PhoenixNetwork;
  /** Account-level extended public key, bech32 `acct_xvk` — safe to display. */
  accountXvkHex: string;
  stakeKeyHashHex: string;
  drepKeyHashHex: string;
  rewardAddress: string;
  external: DerivedAddress[];
  internal: DerivedAddress[];
  /** payment/stake/dRep key hash (hex) → the private key that satisfies it. */
  keyByHash: Map<string, PrivateKey>;
  /** Best-effort scrub of the private key bytes held here. */
  wipe(): void;
};

/**
 * Overwrite the bytes a key object is still holding.
 *
 * Both `PrivateKey.toBytes()` and `Bip32PrivateKey.toBytes()` return the live
 * internal buffer rather than a copy, so filling it with zeroes really does
 * scrub the key — measured, not assumed. A frozen buffer is not worth failing a
 * lock over, so a throw here is swallowed.
 */
function zeroLiveBytes(key: { toBytes(): Uint8Array }): void {
  try {
    key.toBytes().fill(0);
  } catch {
    /* nothing useful to do: the lock must still complete */
  }
}

/** Root extended private key from BIP-39 entropy, per Icarus / CIP-3. */
export async function rootKeyFromEntropy(entropy: Uint8Array): Promise<Bip32PrivateKey> {
  return Bip32PrivateKey.fromEntropy(Buffer.from(entropy));
}

/** `m/1852'/1815'/account'` — the account extended private key. */
export function accountKey(root: Bip32PrivateKey, accountIndex: number): Bip32PrivateKey {
  return root
    .deriveHardened(PURPOSE)
    .deriveHardened(COIN_TYPE)
    .deriveHardened(accountIndex);
}

function pathOf(accountIndex: number, role: number, index: number): string {
  return `1852'/1815'/${accountIndex}'/${role}/${index}`;
}

/**
 * Materialise an account: derive the stake key, the dRep key, and `GAP_LIMIT`
 * addresses on each of the external and internal chains, and index every
 * private key by its hash.
 */
export function buildAccount(
  root: Bip32PrivateKey,
  accountIndex: number,
  network: PhoenixNetwork,
): Account {
  const acct = accountKey(root, accountIndex);

  const stakePrv = acct.derive(ROLE.stake).derive(0).toPrivateKey();
  const drepPrv = acct.derive(ROLE.drep).derive(0).toPrivateKey();
  const stakeKeyHashHex = stakePrv.toPublicKey().hash().toString("hex");
  const drepKeyHashHex = drepPrv.toPublicKey().hash().toString("hex");

  const keyByHash = new Map<string, PrivateKey>();
  keyByHash.set(stakeKeyHashHex, stakePrv);
  keyByHash.set(drepKeyHashHex, drepPrv);

  const chain = (role: number): DerivedAddress[] => {
    const branch = acct.derive(role);
    const out: DerivedAddress[] = [];
    for (let i = 0; i < GAP_LIMIT; i += 1) {
      const prv = branch.derive(i).toPrivateKey();
      const keyHashHex = prv.toPublicKey().hash().toString("hex");
      keyByHash.set(keyHashHex, prv);
      out.push({
        path: pathOf(accountIndex, role, i),
        role,
        index: i,
        keyHashHex,
        address: baseAddress(keyHashHex, stakeKeyHashHex, network),
      });
    }
    return out;
  };

  return {
    accountIndex,
    network,
    accountXvkHex: acct.toBip32PublicKey().toBytes().toString("hex"),
    stakeKeyHashHex,
    drepKeyHashHex,
    rewardAddress: rewardAddress(stakeKeyHashHex, network),
    external: chain(ROLE.external),
    internal: chain(ROLE.internal),
    keyByHash,
    wipe() {
      for (const prv of keyByHash.values()) {
        // `toBytes()` hands back the live buffer, so zeroing it scrubs the key.
        // JavaScript gives no guarantee the engine kept no other copy — this
        // shortens the window, it does not close it. The honest mitigation for
        // a compromised machine is a hardware wallet, and the UI says so.
        zeroLiveBytes(prv);
      }
      keyByHash.clear();
      // The account extended key is the one that mattered most and was the one
      // being missed: every key above is derived *from* it, so leaving it intact
      // meant a lock that scrubbed the leaves and left the trunk. It is wiped
      // last, after the keys derived from it, so an exception part-way through
      // cannot leave the trunk alive while the leaves are already gone.
      zeroLiveBytes(acct);
    },
  };
}

/** Entropy → fully derived account, the whole path in one call. */
export async function accountFromEntropy(
  entropy: Uint8Array,
  accountIndex: number,
  network: PhoenixNetwork,
): Promise<Account> {
  const root = await rootKeyFromEntropy(entropy);
  const account = buildAccount(root, accountIndex, network);
  // The root belongs to this function, not to `buildAccount`, so this is the
  // only place allowed to scrub it — `buildAccount` is also called with a root
  // the caller still owns and must not destroy. The root regenerates every key
  // for every account, so a lock that leaves it in the heap is a lock in name.
  return {
    ...account,
    wipe() {
      account.wipe();
      zeroLiveBytes(root);
    },
  };
}

/** The first external address — what "your address" means in the UI. */
export function primaryAddress(account: Account): string {
  const first = account.external[0];
  if (!first) throw new Error("account has no external addresses");
  return first.address;
}

/** Every address the account controls, for balance lookups and ownership checks. */
export function allAddresses(account: Account): string[] {
  return [...account.external, ...account.internal].map((a) => a.address);
}
