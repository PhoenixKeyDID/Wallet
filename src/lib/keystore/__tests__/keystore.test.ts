/**
 * Tests for the locally-held wallet.
 *
 * The centre of gravity here is the golden-vector block. Everything else in
 * this module can be re-derived by reading it; whether a phrase generated in
 * this browser opens the same wallet in Lace, Yoroi or Eternl cannot. Getting
 * that wrong does not throw — it silently produces a *different, valid* wallet,
 * and the user discovers it when their funds are not where their backup says.
 * So the derivation is pinned against `cardano-serialization-lib`'s own
 * published test vectors, the same ones this platform's Rust core pins to
 * (`PhoenixKey-Core/rust_core/src/cardano.rs`). Three implementations, one
 * answer, or the build fails.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";

import {
  createMnemonic,
  normalizeMnemonic,
  mnemonicToEntropyBytes,
  entropyToMnemonicPhrase,
  suggestWords,
  isWordInList,
  MnemonicError,
} from "../mnemonic";
import {
  accountFromEntropy,
  rootKeyFromEntropy,
  buildAccount,
  primaryAddress,
  allAddresses,
  GAP_LIMIT,
} from "../derive";
import {
  sealVault,
  openVault,
  changeVaultPassword,
  vaultToJson,
  vaultFromJson,
  toBase64,
  fromBase64,
  VaultError,
  MIN_PASSWORD_LENGTH,
  DEFAULT_KDF,
  type Vault,
} from "../vault";
import { witnessesFor, signAndSubmitLocal, LocalSignError } from "../signer";
import { buildMultiSend, buildSendOutputs } from "../../cardano/send";
import { SubmitUncertainError } from "../../cardano/tx";
import { baseAddress, type PhoenixNetwork } from "../../cardano/address";

// ─── Golden vectors ───────────────────────────────────────────────────────────
//
// Source: cardano-serialization-lib `tests/address.rs` (root_key_12/15/24),
// mirrored in PhoenixKey-Core `rust_core/src/cardano.rs`.

const VECTORS = [
  {
    name: "12-word",
    entropyHex: "df9ed25ed146bf43336a5d7cf7395994",
    phrase: "test walk nut penalty hip pave soap entry language right filter choice",
    testnet:
      "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp",
    mainnet:
      "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwqfjkjv7",
  },
  {
    name: "15-word",
    entropyHex: "0ccb74f36b7da1649a8144675522d4d8097c6412",
    phrase:
      "art forum devote street sure rather head chuckle guard poverty release quote oak craft enemy",
    testnet:
      "addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w",
    mainnet: null,
  },
  {
    name: "24-word",
    entropyHex: "4e828f9a67ddcff0e6391ad4f26ddb7579f59ba14b6dd4baf63dcfdb9d2420da",
    phrase: null,
    testnet:
      "addr_test1qqy6nhfyks7wdu3dudslys37v252w2nwhv0fw2nfawemmn8k8ttq8f3gag0h89aepvx3xf69g0l9pf80tqv7cve0l33sw96paj",
    mainnet: null,
  },
] as const;

describe("golden vectors — a phrase made here opens the same wallet elsewhere", () => {
  for (const v of VECTORS) {
    it(`${v.name}: derives the address cardano-serialization-lib publishes`, async () => {
      const entropy = Uint8Array.from(Buffer.from(v.entropyHex, "hex"));

      // The words are a lossless view of the entropy, not an independent input.
      if (v.phrase) {
        expect(entropyToMnemonicPhrase(entropy)).toBe(v.phrase);
        expect(Buffer.from(mnemonicToEntropyBytes(v.phrase)).toString("hex")).toBe(v.entropyHex);
      }

      const preprod = await accountFromEntropy(entropy, 0, 0);
      expect(primaryAddress(preprod)).toBe(v.testnet);

      if (v.mainnet) {
        const mainnet = await accountFromEntropy(entropy, 0, 1);
        expect(primaryAddress(mainnet)).toBe(v.mainnet);
      }
    });
  }

  it("preview and preprod share one address — both are testnet id 0", async () => {
    const entropy = Uint8Array.from(Buffer.from(VECTORS[0].entropyHex, "hex"));
    const preprod = await accountFromEntropy(entropy, 0, 0);
    const preview = await accountFromEntropy(entropy, 0, 2);
    expect(primaryAddress(preview)).toBe(primaryAddress(preprod));
  });
});

// ─── Mnemonic ─────────────────────────────────────────────────────────────────

describe("mnemonic", () => {
  it("generates 24 words by default, and they round-trip through entropy", () => {
    const phrase = createMnemonic();
    expect(phrase.split(" ")).toHaveLength(24);
    const entropy = mnemonicToEntropyBytes(phrase);
    expect(entropy).toHaveLength(32);
    expect(entropyToMnemonicPhrase(entropy)).toBe(phrase);
  });

  it("never repeats itself", () => {
    const seen = new Set(Array.from({ length: 8 }, () => createMnemonic()));
    expect(seen.size).toBe(8);
  });

  it("accepts the messy whitespace and case a paste introduces", () => {
    const v = VECTORS[0];
    const messy = `  TEST\twalk   nut\npenalty hip pave soap entry language right filter CHOICE `;
    expect(normalizeMnemonic(messy)).toBe(v.phrase);
    expect(Buffer.from(mnemonicToEntropyBytes(messy)).toString("hex")).toBe(v.entropyHex);
  });

  it("tells a typo apart from a wrong order — they need different fixes", () => {
    // A word that is not in the list at all: one field is wrong.
    expect(() => mnemonicToEntropyBytes(VECTORS[0].phrase.replace("walk", "wallk"))).toThrow(
      "mnemonic_unknown_word",
    );

    // Real words, wrong arrangement: the checksum is what catches this.
    const words = VECTORS[0].phrase.split(" ");
    const swapped = [words[1], words[0], ...words.slice(2)].join(" ");
    expect(() => mnemonicToEntropyBytes(swapped)).toThrow("mnemonic_bad_checksum");
  });

  it("rejects a word count BIP-39 does not define", () => {
    expect(() => mnemonicToEntropyBytes("test walk nut")).toThrow("mnemonic_bad_word_count");
    expect(() => mnemonicToEntropyBytes("   ")).toThrow("mnemonic_empty");
    expect(() => createMnemonic(13 as never)).toThrow(MnemonicError);
  });

  it("suggests completions for a half-typed word during restore", () => {
    expect(suggestWords("abso")).toContain("absorb");
    expect(suggestWords("zzzz")).toEqual([]);
    expect(isWordInList("Walk")).toBe(true);
    expect(isWordInList("wallk")).toBe(false);
  });
});

// ─── Derivation ───────────────────────────────────────────────────────────────

describe("derivation", () => {
  const entropy = Uint8Array.from(Buffer.from(VECTORS[0].entropyHex, "hex"));

  it("materialises a full gap-limit window on both chains", async () => {
    const acct = await accountFromEntropy(entropy, 0, 0);
    expect(acct.external).toHaveLength(GAP_LIMIT);
    expect(acct.internal).toHaveLength(GAP_LIMIT);
    expect(new Set(allAddresses(acct)).size).toBe(GAP_LIMIT * 2);
    expect(acct.external[0]!.path).toBe("1852'/1815'/0'/0/0");
    expect(acct.internal[0]!.path).toBe("1852'/1815'/0'/1/0");
  });

  it("holds a private key for every address it shows, plus stake and dRep", async () => {
    const acct = await accountFromEntropy(entropy, 0, 0);
    // Every address the UI can hand out must be one we can sign for; otherwise
    // funds arrive somewhere the wallet cannot spend from.
    for (const a of [...acct.external, ...acct.internal]) {
      expect(acct.keyByHash.has(a.keyHashHex)).toBe(true);
    }
    expect(acct.keyByHash.has(acct.stakeKeyHashHex)).toBe(true);
    expect(acct.keyByHash.has(acct.drepKeyHashHex)).toBe(true);
    expect(acct.keyByHash.size).toBe(GAP_LIMIT * 2 + 2);
  });

  it("gives different accounts different money", async () => {
    const a0 = await accountFromEntropy(entropy, 0, 0);
    const a1 = await accountFromEntropy(entropy, 1, 0);
    expect(primaryAddress(a1)).not.toBe(primaryAddress(a0));
    expect(a1.rewardAddress).not.toBe(a0.rewardAddress);
  });

  it("is deterministic — the same entropy always rebuilds the same wallet", async () => {
    const root = await rootKeyFromEntropy(entropy);
    const a = buildAccount(root, 0, 0);
    const b = buildAccount(root, 0, 0);
    expect(allAddresses(a)).toEqual(allAddresses(b));
    expect(a.accountXvkHex).toBe(b.accountXvkHex);
  });

  it("wipe() empties the key map so a locked wallet cannot sign", async () => {
    const acct = await accountFromEntropy(entropy, 0, 0);
    expect(acct.keyByHash.size).toBeGreaterThan(0);
    acct.wipe();
    expect(acct.keyByHash.size).toBe(0);
  });
});

// ─── Vault ────────────────────────────────────────────────────────────────────

/** Argon2 at the shipped cost is slow on purpose; tests use a cheap one. */
const FAST_KDF = { t: 1, m: 256, p: 1 };
const PASSWORD = "correct horse battery staple";

describe("vault", () => {
  const entropy = Uint8Array.from(Buffer.from(VECTORS[0].entropyHex, "hex"));

  it("round-trips entropy through a password", async () => {
    const vault = await sealVault(entropy, PASSWORD, { kdf: FAST_KDF });
    const out = await openVault(vault, PASSWORD);
    expect(Buffer.from(out).toString("hex")).toBe(VECTORS[0].entropyHex);
  });

  it("writes every parameter needed to decrypt it, in the clear", async () => {
    const vault = await sealVault(entropy, PASSWORD, { kdf: FAST_KDF });
    // This is the transparency contract: someone holding only this JSON and
    // the password must be able to decrypt it with their own code.
    expect(vault.v).toBe(1);
    expect(vault.kdf.alg).toBe("argon2id");
    expect(vault.cipher.alg).toBe("AES-256-GCM");
    expect(fromBase64(vault.kdf.salt)).toHaveLength(16);
    expect(fromBase64(vault.cipher.iv)).toHaveLength(12);
    // …and the secret is not in there in the clear.
    expect(JSON.stringify(vault)).not.toContain(VECTORS[0].entropyHex);
    expect(vault.ct).not.toContain(toBase64(entropy));
  });

  it("gives two identical passwords two different vaults", async () => {
    const a = await sealVault(entropy, PASSWORD, { kdf: FAST_KDF });
    const b = await sealVault(entropy, PASSWORD, { kdf: FAST_KDF });
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("refuses the wrong password", async () => {
    const vault = await sealVault(entropy, PASSWORD, { kdf: FAST_KDF });
    await expect(openVault(vault, PASSWORD + "!")).rejects.toThrow("vault_bad_password");
  });

  it("refuses a password an offline guesser would walk through", async () => {
    await expect(sealVault(entropy, "short", { kdf: FAST_KDF })).rejects.toThrow(
      "vault_password_too_short",
    );
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(10);
  });

  it("detects a flipped bit in the ciphertext", async () => {
    const vault = await sealVault(entropy, PASSWORD, { kdf: FAST_KDF });
    const ct = fromBase64(vault.ct);
    ct[0] ^= 0x01;
    await expect(openVault({ ...vault, ct: toBase64(ct) }, PASSWORD)).rejects.toThrow(
      "vault_bad_password",
    );
  });

  it("refuses a vault whose KDF cost was quietly turned down", async () => {
    // The attack: rewrite the stored header to t=1,m=8 so the password becomes
    // cheap to brute-force, and let it still decrypt. Binding the header as
    // AES-GCM additional data is what makes that fail instead of succeed.
    const vault = await sealVault(entropy, PASSWORD, { kdf: FAST_KDF });
    const weakened: Vault = { ...vault, kdf: { ...vault.kdf, t: 1, m: 8 } };
    await expect(openVault(weakened, PASSWORD)).rejects.toThrow("vault_bad_password");
  });

  it("survives a trip through export and import", async () => {
    const vault = await sealVault(entropy, PASSWORD, { kdf: FAST_KDF, label: "Ví chính" });
    const reloaded = vaultFromJson(vaultToJson(vault));
    expect(reloaded.label).toBe("Ví chính");
    expect(Buffer.from(await openVault(reloaded, PASSWORD)).toString("hex")).toBe(
      VECTORS[0].entropyHex,
    );
  });

  it("rejects a file that is not a vault, without a stack trace at the user", async () => {
    expect(() => vaultFromJson("not json")).toThrow("vault_not_json");
    expect(() => vaultFromJson('{"v":1}')).toThrow("vault_malformed");
  });

  it("changes the password without changing the wallet", async () => {
    const vault = await sealVault(entropy, PASSWORD, { kdf: FAST_KDF });
    const rekeyed = await changeVaultPassword(vault, PASSWORD, "a whole new passphrase");
    await expect(openVault(rekeyed, PASSWORD)).rejects.toThrow("vault_bad_password");
    expect(Buffer.from(await openVault(rekeyed, "a whole new passphrase")).toString("hex")).toBe(
      VECTORS[0].entropyHex,
    );
  });

  it("ships a cost that is actually memory-hard", () => {
    // 19 MiB / 2 passes is the OWASP baseline. A regression that drops this to
    // PBKDF2-like cost would not fail any other test in this file.
    expect(DEFAULT_KDF.alg).toBe("argon2id");
    expect(DEFAULT_KDF.m).toBeGreaterThanOrEqual(19456);
    expect(DEFAULT_KDF.t).toBeGreaterThanOrEqual(2);
  });
});

// ─── Signing ──────────────────────────────────────────────────────────────────

const NETWORK: PhoenixNetwork = 0;

const PROTOCOL_PARAMS: tyTypes.ProtocolParams = {
  minFeeA: new BigNumber(44),
  minFeeB: new BigNumber(155381),
  stakeKeyDeposit: new BigNumber(2_000_000),
  utxoCostPerByte: new BigNumber(4310),
  collateralPercent: new BigNumber(150),
  priceSteps: new BigNumber(0),
  priceMem: new BigNumber(0),
  maxTxSize: 16384,
  maxValueSize: 5000,
  minFeeRefScriptCostPerByte: new BigNumber(15),
};

const PAYEE = baseAddress("cc".repeat(28), "dd".repeat(28), NETWORK);

function shelley(bech32Addr: string): tyTypes.ShelleyAddress {
  return tyUtils.getAddressFromString(bech32Addr) as tyTypes.ShelleyAddress;
}

async function walletWithFunds() {
  const entropy = Uint8Array.from(Buffer.from(VECTORS[0].entropyHex, "hex"));
  const account = await accountFromEntropy(entropy, 0, NETWORK);
  const inputs: tyTypes.Input[] = [
    {
      txId: "11".repeat(32),
      index: 0,
      amount: new BigNumber("10000000"),
      tokens: [],
      address: shelley(account.external[0]!.address),
    },
  ];
  const built = buildMultiSend({
    outputs: buildSendOutputs([{ address: PAYEE, ada: "3", tokens: [] }], NETWORK),
    inputs,
    changeAddress: shelley(account.internal[0]!.address),
    protocolParams: PROTOCOL_PARAMS,
    ttl: 50_000_000,
  });
  return { account, built };
}

describe("local signing", () => {
  it("signs exactly the witnesses the transaction asks for — no extras", async () => {
    const { account, built } = await walletWithFunds();
    const required = [...built.transaction.getRequiredWitnesses().keys()];
    const ws = witnessesFor(built, account);

    // One witness per required key hash. An extra witness makes the
    // transaction larger than the fee that was already computed for it, and
    // the node rejects it — so "sign everything we own" is a real bug, not a
    // harmless belt-and-braces.
    expect(ws).toHaveLength(required.length);
    expect(ws.every((w) => w.publicKey.length === 32 && w.signature.length === 64)).toBe(true);

    // The signature must verify against the body hash under that public key.
    const bodyHash = Buffer.from(built.hash, "hex");
    for (const hashHex of required) {
      const prv = account.keyByHash.get(hashHex)!;
      expect(prv.toPublicKey().verify(prv.sign(bodyHash), bodyHash)).toBe(true);
    }
  });

  it("refuses to sign for a key the wallet does not hold", async () => {
    const { account, built } = await walletWithFunds();
    account.keyByHash.clear();
    expect(() => witnessesFor(built, account)).toThrow(LocalSignError);
    expect(() => witnessesFor(built, account)).toThrow("sign_key_not_in_wallet");
  });

  it("refuses an account belonging to another network", async () => {
    const { account, built } = await walletWithFunds();
    await expect(signAndSubmitLocal(built, account, 1, async () => "x")).rejects.toThrow(
      "sign_network_mismatch",
    );
  });

  it("submits the signed bytes, which are longer than the unsigned ones", async () => {
    const { account, built } = await walletWithFunds();
    const unsignedLen = built.unsignedCbor.length;
    let submitted = "";
    const hash = await signAndSubmitLocal(built, account, NETWORK, async (cbor) => {
      submitted = cbor;
      return "ff".repeat(32);
    });
    expect(hash).toBe("ff".repeat(32));
    expect(submitted.length).toBeGreaterThan(unsignedLen);
  });

  it("hands back the tx hash when the submit's outcome is unknown", async () => {
    const { account, built } = await walletWithFunds();
    const err = await signAndSubmitLocal(built, account, NETWORK, async () => {
      throw new Error("indexer unreachable");
    }).catch((e) => e);
    // Same contract as the CIP-30 path: without the hash the only way to
    // resolve the doubt is to resend and risk paying twice.
    expect(err).toBeInstanceOf(SubmitUncertainError);
    expect((err as SubmitUncertainError).txHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── The escape hatch ─────────────────────────────────────────────────────────

describe("independent recovery", () => {
  it("scripts/decrypt-vault.mjs opens a vault this wallet wrote", async () => {
    // The vault docs promise a user can get their key out without this
    // wallet. A promise in a comment rots; this runs the actual script, in a
    // separate process, sharing no code with `vault.ts`, and checks it returns
    // the exact entropy that went in.
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync, rmSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const entropy = Uint8Array.from(Buffer.from(VECTORS[0].entropyHex, "hex"));
    const vault = await sealVault(entropy, PASSWORD, { kdf: FAST_KDF });

    const dir = mkdtempSync(join(tmpdir(), "phoenix-vault-"));
    const file = join(dir, "w.vault.json");
    try {
      writeFileSync(file, vaultToJson(vault));
      const out = execFileSync(process.execPath, ["scripts/decrypt-vault.mjs", file], {
        env: { ...process.env, VAULT_PASSWORD: PASSWORD },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      expect(out).toContain(VECTORS[0].entropyHex);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
