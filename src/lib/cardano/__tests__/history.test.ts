/**
 * Reading a transaction back from the chain.
 *
 * Every fixture below is shaped like a real Koios row, and the withdrawal case
 * carries the actual figures of mainnet transaction
 * `8d8edcbbd7634b487bc7f8914211eb580c241d6b0f3059e11c15219051d19ff2`, read from
 * the live indexer on 2026-09-05: fee 181121, block 13906190, a withdrawal of
 * 8112385 lovelace, and 214457817986 of asset `4e49474854` ("NIGHT"). Pinning a
 * transaction that exists is what keeps this file honest about the shape the
 * indexer really returns, rather than the shape this module wishes for.
 */
import { describe, it, expect } from "vitest";
import {
  readTx,
  rowDisplay,
  confirmationsOf,
  HistoryError,
  type HistoryEntry,
} from "../history";

const MINE = "addr1_mine";
const OTHER = "addr1_someone_else";
/** Real shape, from the measured mainnet row quoted above. */
const MY_STAKE = "stake1uyckuvwthqs0yn3k0356n0wdhh395upurrfmlh4d6w4m68gjk2m5q";
const THEIR_STAKE = "stake1uxv552uap8evl7adym6je4rpu5370u5vwd90r3lxwzmpjvchlk60c";
const mine = new Set([MY_STAKE]);
const NIGHT = { policy_id: "a".repeat(56), asset_name: "4e49474854", quantity: "214457817986" };
const own = new Set([MINE]);

const io = (
  addr: string,
  lovelace: string,
  assets: Array<{ policy_id: string; asset_name: string; quantity: string }> = [],
) => ({
  payment_addr: { bech32: addr },
  value: lovelace,
  asset_list: assets,
});

const ada = (e: HistoryEntry) => e.net.find((n) => n.unit === "")?.amount;

describe("readTx — the amount is this wallet's, not the transaction's", () => {
  /**
   * The miscount that turns "I paid 5" into "I paid 95". A send spends one big
   * UTxO and hands most of it straight back as change; only the difference left.
   */
  it("does not count change as money paid out", () => {
    const e = readTx(
      {
        tx_hash: "aa",
        fee: "170000",
        block_height: 1,
        tx_timestamp: 1788705807,
        inputs: [io(MINE, "100000000")],
        outputs: [io(OTHER, "5000000"), io(MINE, "94830000")],
      },
      own,
    );
    expect(ada(e)).toBe(BigInt(-5170000)); // 5 ADA out, plus the fee
    expect(e.kind).toBe("sent");
    expect(e.counterparties).toEqual([OTHER]);
  });

  /**
   * The fee is inside the input/output difference already. This pins the total
   * against double-subtraction, which would quietly overstate every send.
   */
  it("counts the fee once, because it is already in the difference", () => {
    const e = readTx(
      {
        tx_hash: "bb",
        fee: "200000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(MINE, "10000000")],
        outputs: [io(MINE, "9800000")],
      },
      own,
    );
    expect(ada(e)).toBe(BigInt(-200000));
    expect(e.fee).toBe(BigInt(200000));
    expect(e.kind).toBe("internal");
  });

  /**
   * Staking rewards enter through the withdrawals field and are never an input.
   * A reading that only knows inputs and outputs reports this as *income with
   * no source* — the mirror of the blind spot on the signing path, where the
   * same omission let a page drain the rewards behind a screen saying nothing
   * was leaving.
   */
  it("treats a withdrawal as rewards arriving, not as money from nowhere", () => {
    const e = readTx(
      {
        tx_hash: "8d8edcbbd7634b487bc7f8914211eb580c241d6b0f3059e11c15219051d19ff2",
        fee: "181121",
        block_height: 13906190,
        tx_timestamp: 1788705807,
        inputs: [io(MINE, "2000000")],
        outputs: [io(MINE, "9931264", [NIGHT])],
        withdrawals: [{ amount: "8112385", stake_addr: MY_STAKE }],
      },
      own,
      mine,
    );
    // Returned 9931264, spent 2000000, of which 8112385 was reward money that
    // was never ours to begin with: the wallet's own ADA fell by the fee.
    expect(ada(e)).toBe(BigInt(-181121));
    expect(e.withdrawnLovelace).toBe(BigInt(8112385));
    expect(e.kind).toBe("withdrawal");
    expect(e.blockHeight).toBe(13906190);
    expect(e.timeMs).toBe(1788705807000);
  });

  it("carries a token through with its full precision", () => {
    const e = readTx(
      {
        tx_hash: "cc",
        fee: "170000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(MINE, "5000000")],
        outputs: [io(MINE, "4830000", [NIGHT])],
      },
      own,
    );
    const tok = e.net.find((n) => n.assetNameHex === "4e49474854");
    // A number this size does not survive a float; it must arrive as a bigint.
    expect(tok?.amount).toBe(BigInt("214457817986"));
    expect(tok?.policyId).toBe("a".repeat(56));
  });

  it("says received when nothing of ours was spent", () => {
    const e = readTx(
      {
        tx_hash: "dd",
        fee: "170000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(OTHER, "10000000")],
        outputs: [io(MINE, "9830000")],
      },
      own,
    );
    expect(ada(e)).toBe(BigInt(9830000));
    expect(e.kind).toBe("received");
    expect(e.counterparties).toEqual([]); // nobody to name: it arrived
  });

  it("leaves out an asset that came in and went straight back out", () => {
    const e = readTx(
      {
        tx_hash: "ee",
        fee: "170000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(MINE, "5000000", [NIGHT])],
        outputs: [io(MINE, "4830000", [NIGHT])],
      },
      own,
    );
    expect(e.net.find((n) => n.assetNameHex === "4e49474854")).toBeUndefined();
    expect(ada(e)).toBe(BigInt(-170000));
  });

  /**
   * The refusal that matters: a row the module cannot fully attribute must not
   * produce a number. Skipping the unreadable part would leave every total short
   * by exactly the amount nobody could see.
   */
  it("refuses a row whose address it cannot read, rather than under-reporting", () => {
    expect(() =>
      readTx(
        {
          tx_hash: "ff",
          fee: "170000",
          block_height: 1,
          tx_timestamp: 1,
          inputs: [io(MINE, "5000000")],
          outputs: [{ payment_addr: null, value: "4830000" }],
        },
        own,
      ),
    ).toThrow(HistoryError);
  });

  /**
   * The indexer is an unauthenticated public service, so it can be made to
   * return this: an asset row whose policy id and name are both empty. The unit
   * key is `policyId + nameHex`, and ADA's key is the empty string — so the
   * quantity lands on the ADA total itself, not on a token line anyone would
   * look at twice. A real policy id is blake2b-224: 56 hex characters, always.
   */
  it("refuses an asset whose policy id would collide with the key ADA uses", () => {
    expect(() =>
      readTx(
        {
          tx_hash: "kk",
          fee: "170000",
          block_height: 1,
          tx_timestamp: 1,
          inputs: [io(MINE, "5000000")],
          outputs: [
            io(MINE, "4830000", [{ policy_id: "", asset_name: "", quantity: "999999999999" }]),
          ],
        },
        own,
      ),
    ).toThrow(HistoryError);
  });

  it("refuses a policy id that is the wrong length to be one", () => {
    expect(() =>
      readTx(
        {
          tx_hash: "ll",
          fee: "170000",
          block_height: 1,
          tx_timestamp: 1,
          inputs: [io(MINE, "5000000")],
          outputs: [io(MINE, "4830000", [{ policy_id: "abcd", asset_name: "", quantity: "1" }])],
        },
        own,
      ),
    ).toThrow(HistoryError);
  });

  /**
   * The miscount that lets a stranger write a number onto your screen.
   *
   * A withdrawal belongs to whoever owns the stake address inside it, and one
   * transaction can carry several people's. Anyone can build this shape without
   * any special access: pay someone 5 ADA in the same transaction that claims
   * your own 100 ADA of staking rewards. Summing every withdrawal and taking it
   * off this wallet's total turns that into **"received −95 ADA"**, stated with
   * as much confidence as any other row.
   */
  it("does not subtract a stranger's reward withdrawal from this wallet", () => {
    const e = readTx(
      {
        tx_hash: "jj",
        fee: "170000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(OTHER, "200000000")],
        outputs: [io(MINE, "5000000"), io(OTHER, "294830000")],
        withdrawals: [{ amount: "100000000", stake_addr: THEIR_STAKE }],
      },
      own,
      mine,
    );
    expect(ada(e)).toBe(BigInt(5000000)); // the 5 ADA they sent, and nothing else
    expect(e.kind).toBe("received");
    expect(e.withdrawnLovelace).toBe(BigInt(0)); // their rewards, not ours
    expect(e.unattributed).toBeNull();
  });

  /**
   * Same transaction, but the wallet does not know its own reward address — the
   * case a CIP-30 connection can leave it in. It cannot tell whose withdrawal
   * this is, so it must not produce a figure either way: counting it is
   * "−95 ADA", ignoring it is wrong whenever the withdrawal really was ours.
   */
  it("shows no amount at all when it cannot tell whose withdrawal it is", () => {
    const e = readTx(
      {
        tx_hash: "jj",
        fee: "170000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(OTHER, "200000000")],
        outputs: [io(MINE, "5000000"), io(OTHER, "294830000")],
        withdrawals: [{ amount: "100000000", stake_addr: THEIR_STAKE }],
      },
      own,
      new Set(), // reward address unknown
    );
    expect(e.unattributed).toBe("withdrawal_owner_unknown");
    const d = rowDisplay(e, true);
    expect(d.show).toBe(false);
    if (d.show) throw new Error("unreachable");
    expect(d.reason).toBe("withdrawal_owner_unknown");
  });

  it("refuses a withdrawal with no owner named on it", () => {
    expect(() =>
      readTx(
        {
          tx_hash: "jj",
          fee: "170000",
          block_height: 1,
          tx_timestamp: 1,
          inputs: [io(MINE, "2000000")],
          outputs: [io(MINE, "9931264")],
          withdrawals: [{ amount: "8112385" }],
        },
        own,
        mine,
      ),
    ).toThrow(HistoryError);
  });

  /**
   * `?? 0` on either of these prints `1/1/1970` and `Block 0` as facts, in a
   * module whose whole argument is that refusing beats a plausible wrong number.
   */
  it("refuses a row with no timestamp or no block height", () => {
    const base = { tx_hash: "oo", fee: "1", inputs: [io(MINE, "2")], outputs: [io(MINE, "1")] };
    expect(() => readTx({ ...base, block_height: 1 }, own)).toThrow(HistoryError);
    expect(() => readTx({ ...base, tx_timestamp: 1 }, own)).toThrow(HistoryError);
  });

  it("refuses an amount that is not a whole number", () => {
    expect(() =>
      readTx(
        {
          tx_hash: "gg",
          fee: "170000",
          block_height: 1,
          tx_timestamp: 1,
          inputs: [io(MINE, "5.5")],
          outputs: [io(MINE, "1")],
        },
        own,
      ),
    ).toThrow(HistoryError);
  });

  it("names a delegation by what it did, not by the fee it cost", () => {
    const e = readTx(
      {
        tx_hash: "hh",
        fee: "180000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(MINE, "10000000")],
        outputs: [io(MINE, "9820000")],
        certificates: [{ type: "delegation", info: { stake_address: MY_STAKE } }],
      },
      own,
      mine,
    );
    expect(e.kind).toBe("delegation");
  });

  /**
   * A transaction has many parties. Someone else registering or deregistering
   * their stake key in the same transaction that takes a fee from us did not
   * change *our* staking, and the label is what a person uses to decide whether
   * a row deserves a second look.
   */
  it("does not call it a delegation when the certificate is a stranger's", () => {
    const e = readTx(
      {
        tx_hash: "mm",
        fee: "180000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(MINE, "10000000")],
        outputs: [io(MINE, "9820000")],
        certificates: [{ type: "stake_deregistration", info: { stake_address: THEIR_STAKE } }],
      },
      own,
      mine,
    );
    expect(e.kind).toBe("internal");
  });

  /**
   * The fee comes out of the transaction's inputs. On a receive we funded
   * nothing, so the sender paid it and it is not inside our net — a screen
   * printing "−0.170000" there tells someone who just received 5 ADA they got
   * 4.83, and they go looking for the missing 0.17.
   */
  it("knows the sender paid the fee when nothing of ours was spent", () => {
    const received = readTx(
      {
        tx_hash: "pp",
        fee: "170000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(OTHER, "10000000")],
        outputs: [io(MINE, "9830000")],
      },
      own,
      mine,
    );
    expect(received.feePaidByUs).toBe(false);
    expect(ada(received)).toBe(BigInt(9830000)); // and the fee is not in it

    const sent = readTx(
      {
        tx_hash: "qq",
        fee: "170000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(MINE, "10000000")],
        outputs: [io(OTHER, "5000000"), io(MINE, "4830000")],
      },
      own,
      mine,
    );
    expect(sent.feePaidByUs).toBe(true);
  });

  /**
   * Anyone can relabel a payment to you: send ADA and mint one unit of a junk
   * token into the same transaction. Without checking that *we* funded it, the
   * row reads "Minted a token" — and a real incoming payment gets filed away as
   * noise by the one label the reader uses to triage.
   */
  it("does not let a stranger's mint relabel money arriving", () => {
    const e = readTx(
      {
        tx_hash: "rr",
        fee: "170000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(OTHER, "10000000")],
        outputs: [io(MINE, "9830000", [NIGHT])],
        assets_minted: [NIGHT],
      },
      own,
      mine,
    );
    expect(e.kind).toBe("received");
  });

  /**
   * Koios reports a burn in `assets_minted` with a negative quantity. Matching
   * on the unit alone calls destroying a token "Minted a token".
   */
  it("does not call a burn a mint", () => {
    const e = readTx(
      {
        tx_hash: "ss",
        fee: "170000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(MINE, "5000000", [NIGHT])],
        outputs: [io(MINE, "4830000")],
        assets_minted: [{ ...NIGHT, quantity: "-214457817986" }],
      },
      own,
      mine,
    );
    expect(e.kind).toBe("internal");
  });

  it("does not call it a mint when the minted asset never reached this wallet", () => {
    const e = readTx(
      {
        tx_hash: "nn",
        fee: "180000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(MINE, "10000000")],
        outputs: [io(MINE, "9820000")],
        // Minted in this transaction, and handed to someone else entirely.
        assets_minted: [{ policy_id: "b".repeat(56), asset_name: "4e4654", quantity: "1" }],
      },
      own,
      mine,
    );
    expect(e.kind).toBe("internal");
  });

  /**
   * A transaction can be several things at once. When money went to someone
   * else, that is the reason the person is looking at the row, so it wins over
   * the certificate that rode along with it.
   */
  it("calls it a send when a certificate rides along with money leaving", () => {
    const e = readTx(
      {
        tx_hash: "ii",
        fee: "180000",
        block_height: 1,
        tx_timestamp: 1,
        inputs: [io(MINE, "10000000")],
        outputs: [io(OTHER, "4000000"), io(MINE, "5820000")],
        certificates: [{ type: "delegation" }],
      },
      own,
    );
    expect(e.kind).toBe("sent");
  });
});

/**
 * What the screen is allowed to say. These two functions are the whole reason
 * the panel has no arithmetic of its own: without React test tooling in this
 * repo, logic left inside JSX is logic nothing can bite.
 */
describe("rowDisplay — a plausible wrong number is worse than an admission", () => {
  const entry = (): HistoryEntry => ({
    txHash: "aa",
    timeMs: 0,
    blockHeight: 100,
    fee: BigInt(170000),
    withdrawnLovelace: BigInt(0),
    net: [
      { unit: "", policyId: "", assetNameHex: "", amount: BigInt(-5170000) },
      { unit: "p".repeat(56) + "4e49474854", policyId: "p".repeat(56), assetNameHex: "4e49474854", amount: BigInt(7) },
    ],
    kind: "sent",
    counterparties: [OTHER],
    unattributed: null,
    feePaidByUs: true,
  });

  it("shows the amount when the wallet knows all of its own addresses", () => {
    const d = rowDisplay(entry(), true);
    expect(d.show).toBe(true);
    if (!d.show) throw new Error("unreachable");
    expect(d.ada).toBe(BigInt(-5170000));
    expect(d.tokens).toHaveLength(1);
  });

  /**
   * The miscount this refusal exists for: an extension that withheld one of its
   * own addresses makes its own change look like a payment, so a 5 ADA send off
   * a 100 ADA input would read as "sent 95". That number is believable, which
   * is exactly why it must not be shown.
   */
  it("refuses to show an amount when the wallet lists only some of its addresses", () => {
    const d = rowDisplay(entry(), false);
    expect(d.show).toBe(false);
    if (d.show) throw new Error("unreachable");
    expect(d.reason).toBe("owned_set_incomplete");
  });
});

describe("confirmationsOf", () => {
  const at = (blockHeight: number): HistoryEntry => ({
    txHash: "aa",
    timeMs: 0,
    blockHeight,
    fee: BigInt(0),
    withdrawnLovelace: BigInt(0),
    net: [],
    kind: "internal",
    counterparties: [],
    unattributed: null,
    feePaidByUs: true,
  });

  it("counts the block itself as the first confirmation", () => {
    // The real figures: transaction in 13906190, tip at 13906190 → just landed.
    expect(confirmationsOf(at(13906190), 13906190)).toBe(1);
    expect(confirmationsOf(at(13906190), 13906415)).toBe(226);
  });

  /**
   * The tip and the transaction list are two separate calls, so a block minted
   * between them puts the tip behind the entry. Answering "0" or "-1" there
   * would be a number a person acts on — waiting for a confirmation that has
   * already happened, or treating a payment as unsettled.
   */
  it("says nothing rather than a negative when the tip is behind", () => {
    expect(confirmationsOf(at(13906191), 13906190)).toBeNull();
    expect(confirmationsOf(at(13906190), null)).toBeNull();
    expect(confirmationsOf(at(0), 13906190)).toBeNull();
  });
});
