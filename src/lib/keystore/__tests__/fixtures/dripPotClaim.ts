/**
 * A LAMP drip-pot claim transaction in the shape the service builds it.
 *
 * Mirrors `buildClaim` in LAMP `Distribution/drip-pot/service/src/core/txbuild.ts`
 * at 03d5c79 (https://github.com/MagicLampEco/LAMP/blob/03d5c79373e402de229380d5907da00dc87abe68/Distribution/drip-pot/service/src/core/txbuild.ts#L84),
 * final-claim branch: spend the account UTxO at the pot script, pay the vault
 * (this wallet) the LAMP due with an inline tag datum, burn the account's one
 * auth token, validity window `[lo, hi]`, collateral from the wallet with a
 * return to the wallet, the script by reference. Lucid itself is not run here
 * — it needs a chain provider — so the CBOR is assembled field by field, and
 * `extra` lets a test put back exactly one thing the wallet must refuse.
 */
import "../../../node-globals";
import { Buffer } from "buffer";
import { CborTag, Encoder } from "@stricahq/cbors";

export const POT_SCRIPT_HASH = "a1".repeat(28);
export const LAMP_POLICY = "c0".repeat(28);
export const LAMP_NAME = Buffer.from("LAMP").toString("hex");
export const AUTH_POLICY = POT_SCRIPT_HASH; // the pot's own minting policy
export const AUTH_NAME = "aa".repeat(28);
export const POT_TX = "51".repeat(32);
export const REF_TX = "52".repeat(32);

export type ClaimOpts = {
  walletAddressHex: string;
  feeInput: { txId: string; index: number };
  collateralInput: { txId: string; index: number; lovelace: bigint };
  network: 0 | 1;
  claimLamp?: bigint;
  /** Mutate the body before encoding, to add the one field under test. */
  extra?: (body: Map<number, unknown>) => void;
  isValid?: boolean;
};

export function dripClaimTxHex(o: ClaimOpts): string {
  const potAddress = Buffer.concat([Buffer.from([0x70 | o.network]), Buffer.from(POT_SCRIPT_HASH, "hex")]);
  const wallet = Buffer.from(o.walletAddressHex, "hex");
  const lamp = o.claimLamp ?? BigInt(1_000_000_000);
  // Tag datum: Constr 0 [pot txid, index] — `dripTagDatum` in LAMP.
  const tagDatum = Encoder.encode(new CborTag([Buffer.from(POT_TX, "hex"), 0], 121));
  const collateralReturn = o.collateralInput.lovelace - BigInt(1_500_000);

  const body = new Map<number, unknown>([
    [0, [[Buffer.from(POT_TX, "hex"), 0], [Buffer.from(o.feeInput.txId, "hex"), o.feeInput.index]]],
    [
      1,
      [
        new Map<number, unknown>([
          [0, wallet],
          [1, [BigInt(1_300_000), new Map([[Buffer.from(LAMP_POLICY, "hex"), new Map([[Buffer.from(LAMP_NAME, "hex"), lamp]])]])]],
          [2, [1, new CborTag(tagDatum, 24)]],
        ]),
        [wallet, BigInt(3_200_000)],
      ],
    ],
    [2, BigInt(450_000)],
    [3, BigInt(80_000_600)],
    [8, BigInt(80_000_000)],
    [9, new Map([[Buffer.from(AUTH_POLICY, "hex"), new Map([[Buffer.from(AUTH_NAME, "hex"), -1]])]])],
    [11, Buffer.alloc(32, 0x5d)],
    [13, [[Buffer.from(o.collateralInput.txId, "hex"), o.collateralInput.index]]],
    [16, new Map<number, unknown>([[0, wallet], [1, collateralReturn]])],
    [17, BigInt(1_500_000)],
    [18, [[Buffer.from(REF_TX, "hex"), 0]]],
  ]);
  o.extra?.(body);
  // Witness set as the dApp hands it over: redeemers only (spend 0, mint 0), no vkeys yet.
  const witnesses = new Map<number, unknown>([
    [
      5,
      [
        [0, 0, new CborTag([], 121), [BigInt(1_000_000), BigInt(400_000_000)]],
        [1, 0, new CborTag([], 122), [BigInt(500_000), BigInt(200_000_000)]],
      ],
    ],
  ]);
  return Encoder.encode([body, witnesses, o.isValid ?? true, null]).toString("hex");
}
