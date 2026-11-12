/**
 * Đòn tấn công vào luồng ký giao dịch của người khác.
 *
 * Hai hội đồng độc lập dựng lại được cùng một đường: một trang đã được cấp
 * quyền gửi một giao dịch mà **màn duyệt mô tả là vô hại** và **ví vẫn ký bằng
 * khoá stake**. Cửa là trường 14 `required_signers`: nó gọi tên thẳng khoá nó
 * muốn chữ ký, và không có ràng buộc nào nối tên đó với thứ màn hình đã hiện.
 *
 * Các bài dưới đây là bản dựng lại đòn, không phải bài kiểm tính năng. Bài nào
 * xanh nghĩa là đường đó đã đóng; bài nào đỏ là đường đó đang mở.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { Encoder } from "@stricahq/cbors";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import { accountFromEntropy, type Account } from "../derive";
import { requiredKeysFor, signForeignTx, type WalletView } from "../signForeign";
import { summariseTx } from "../../cardano/txSummary";
import { baseAddress, type PhoenixNetwork } from "../../cardano/address";

const NETWORK: PhoenixNetwork = 0;
const ENTROPY = Uint8Array.from(Buffer.alloc(32, 7));
const ATTACKER = baseAddress("ab".repeat(28), "cd".repeat(28), NETWORK);
const THEIR_TXID = "11".repeat(32);

let account: Account;
/** A wallet holding nothing it can attribute: the cache is empty. */
const NO_VIEW: WalletView = { ownAddressesHex: [], held: new Map() };
const acct = async () => (account ??= await accountFromEntropy(ENTROPY, 0, NETWORK));

const addrHex = (bech32: string) =>
  (tyUtils.getAddressFromString(bech32) as tyTypes.ShelleyAddress).getHex();
/** The wallet's own addresses and no UTxO: what the screen needs to count this wallet's rewards as its own. */
const addressesOnly = (a: Account): WalletView => ({ ownAddressesHex: a.external.map((d) => addrHex(d.address)), held: new Map() });

/** `stake` reward account: một byte đầu (0xe0 | network) rồi 28 byte hash. */
const rewardAccount = (stakeKeyHashHex: string) =>
  Buffer.concat([Buffer.from([0xe0 | NETWORK]), Buffer.from(stakeKeyHashHex, "hex")]);

/** Dựng CBOR giao dịch thô — không qua typhon, vì đòn nằm ở chỗ typhon không dựng. */
function tx(body: Map<number, unknown>): string {
  return Encoder.encode([body, new Map(), true, null]).toString("hex");
}

describe("rút sạch phần thưởng staking", () => {
  it("từ chối ký khoá stake khi trường 14 gọi tên nó mà thân giao dịch không nói vì sao", async () => {
    const a = await acct();
    const body = new Map<number, unknown>([
      // Đầu vào của chính kẻ tấn công: ví không nhận ra, nên "không tốn gì".
      [0, [[Buffer.from(THEIR_TXID, "hex"), 0]]],
      [1, [[Buffer.from(addrHex(ATTACKER), "hex"), 9_000_000]]],
      [2, 200_000],
      // Rút từ tài khoản thưởng của NGƯỜI KHÁC — không biện minh cho khoá này.
      [5, new Map([[rewardAccount("ee".repeat(28)), 500_000_000]])],
      // Cửa: gọi tên thẳng khoá stake của người dùng.
      [14, [Buffer.from(a.stakeKeyHashHex, "hex")]],
    ]);
    expect(() => signForeignTx(tx(body), a, NO_VIEW, false)).toThrow(/sign_unjustified_signer/);
  });

  it("ký khoản rút của chính ví — nhưng chỉ vì thân giao dịch nêu đúng tài khoản đó", async () => {
    const a = await acct();
    const body = new Map<number, unknown>([
      [0, [[Buffer.from(THEIR_TXID, "hex"), 0]]],
      [1, [[Buffer.from(addrHex(ATTACKER), "hex"), 9_000_000]]],
      [2, 200_000],
      [5, new Map([[rewardAccount(a.stakeKeyHashHex), 500_000_000]])],
      [14, [Buffer.from(a.stakeKeyHashHex, "hex")]],
    ]);
    // Chữ ký hợp lệ ở đây là đúng: rút thưởng thật sự cần khoá stake. Thứ giữ
    // cho nó an toàn là màn hình phải nói ra 500 ADA — bài ngay dưới — nên
    // view phải có địa chỉ của ví để màn hình tính khoản rút là của ví.
    expect(() => signForeignTx(tx(body), a, addressesOnly(a), false)).not.toThrow();
  });

  it("số trên màn phải nói khoản rút đi ra ngoài, không nói 'không mất gì'", async () => {
    const a = await acct();
    const body = new Map<number, unknown>([
      [0, [[Buffer.from(THEIR_TXID, "hex"), 0]]],
      [1, [[Buffer.from(addrHex(ATTACKER), "hex"), 9_000_000]]],
      [2, 200_000],
      [5, new Map([[rewardAccount(a.stakeKeyHashHex), 500_000_000]])],
      [14, [Buffer.from(a.stakeKeyHashHex, "hex")]],
    ]);
    const s = summariseTx(
      tx(body),
      a.external.map((d) => addrHex(d.address)),
      new Map(),
      0,
    );
    const ada = s.net.find((n) => n.unit === "");
    // 500 ADA rời ví. Con số quyết định phải nói đúng chiều đó.
    expect(ada?.amount).toBe(BigInt(500_000_000));
  });
});

describe("uỷ quyền biểu quyết mà không hiện gì", () => {
  it("từ chối ký bằng khoá DRep khi không mô tả được", async () => {
    const a = await acct();
    const body = new Map<number, unknown>([
      [0, [[Buffer.from(THEIR_TXID, "hex"), 0]]],
      [1, [[Buffer.from(addrHex(ATTACKER), "hex"), 1_000_000]]],
      [2, 200_000],
      [14, [Buffer.from(a.drepKeyHashHex, "hex")]],
    ]);
    expect(() => signForeignTx(tx(body), a, NO_VIEW, false)).toThrow();
  });
});

describe("đầu vào ví không tra được", () => {
  it("không ký bằng khoá payment mà trường 14 gọi tên, khi đầu vào không tra được", async () => {
    const a = await acct();
    const mineHex = addrHex(a.external[0]!.address);
    const paymentHash = (
      tyUtils.getAddressFromString(a.external[0]!.address) as unknown as {
        paymentCredential: { hash: Buffer };
      }
    ).paymentCredential.hash.toString("hex");
    const body = new Map<number, unknown>([
      [
        0,
        [
          [Buffer.from(THEIR_TXID, "hex"), 0],
          // Đầu vào 1.500 ADA của người dùng, nằm ngoài dải địa chỉ đã quét.
          [Buffer.from("22".repeat(32), "hex"), 3],
        ],
      ],
      [
        1,
        [
          [Buffer.from(mineHex, "hex"), 1_000_000],
          [Buffer.from(addrHex(ATTACKER), "hex"), 1_498_000_000],
        ],
      ],
      [2, 200_000],
      [14, [Buffer.from(paymentHash, "hex")]],
    ]);
    // Bộ nhớ đệm rỗng: ví không tra được đầu vào nào.
    expect(() => signForeignTx(tx(body), a, NO_VIEW, false)).toThrow();
  });
});

/**
 * Chiều ngược của các đòn trên: khoá stake mà ledger THẬT SỰ đòi phải được ký,
 * kể cả khi trang không gọi tên nó ở trường 14. Trước đây khoản rút / chứng chỉ
 * chỉ "biện minh" cho khoá mà không đưa nó vào tập cần ký ⇒ mọi dApp staking
 * nhận về bộ chữ ký thiếu khoá stake và node từ chối giao dịch.
 */
describe("khoá stake của khoản rút thưởng thì phải ký, không cần trường 14", () => {
  const base = () =>
    new Map<number, unknown>([
      [0, [[Buffer.from(THEIR_TXID, "hex"), 0]]],
      [1, [[Buffer.from(addrHex(ATTACKER), "hex"), 1_000_000]]],
      [2, 200_000],
    ]);

  it("rút thưởng của chính ví: khoá stake nằm trong tập cần ký", async () => {
    const a = await acct();
    const body = base();
    body.set(5, new Map([[rewardAccount(a.stakeKeyHashHex), 5_000_000]]));
    expect(requiredKeysFor(tx(body), a, addressesOnly(a)).keyHashes).toEqual([a.stakeKeyHashHex]);
    // Và chữ ký ra thật, không phải "không có gì để ký".
    expect(() => signForeignTx(tx(body), a, addressesOnly(a), false)).not.toThrow();
  });

  // Vòng soát 3, đòn 2: hàm ký thêm khoá stake theo `account.stakeKeyHashHex`,
  // còn màn hình tính khoản rút là của ví theo phần stake trong
  // `view.ownAddressesHex`. View rỗng ⟹ màn hình nói "thưởng của người khác,
  // không rời ví này" trong khi hàm ký vẫn ký 500 ADA thưởng của ví đi.
  it("view không có địa chỉ: màn hình không tính khoản rút là của ví, nên hàm ký từ chối", async () => {
    const a = await acct();
    const body = new Map<number, unknown>([
      [0, [[Buffer.from(THEIR_TXID, "hex"), 0]]],
      [1, [[Buffer.from(addrHex(ATTACKER), "hex"), 500_000_000]]],
      [2, 200_000],
      [5, new Map([[rewardAccount(a.stakeKeyHashHex), 500_000_000]])],
    ]);
    const s = summariseTx(tx(body), NO_VIEW.ownAddressesHex, NO_VIEW.held, 0);
    expect(s.foreignWithdrawals).toBe(1);
    expect(s.ownRewardKeyHashes).toEqual([]);
    expect(() => requiredKeysFor(tx(body), a, NO_VIEW)).toThrow(/^sign_foreign_withdrawal_mismatch: /);
    expect(() => signForeignTx(tx(body), a, NO_VIEW, true)).toThrow(/^sign_foreign_withdrawal_mismatch: /);
  });

  it("view của tài khoản khác: màn hình tính khoản rút của tài khoản kia là của ví, hàm ký từ chối", async () => {
    const a = await acct();
    const other = await accountFromEntropy(ENTROPY, 1, NETWORK);
    const body = new Map<number, unknown>([
      [0, [[Buffer.from(THEIR_TXID, "hex"), 0]]],
      [1, [[Buffer.from(addrHex(ATTACKER), "hex"), 5_000_000]]],
      [2, 200_000],
      [5, new Map([[rewardAccount(other.stakeKeyHashHex), 5_000_000]])],
    ]);
    expect(() => signForeignTx(tx(body), a, addressesOnly(other), true)).toThrow(/^sign_foreign_withdrawal_mismatch: /);
  });

  // Mã băm stake của chính ví nhưng byte đầu nói mạng khác (0xe1 trên ví
  // testnet) hoặc credential script (0xf0): không phải tài khoản thưởng của ví.
  // Màn hình tính là của bên ngoài và hàm ký không thêm khoá stake — hai bên
  // cùng đọc một hàm nên không vênh (không ném mismatch).
  it.each([
    ["mạng khác", 0xe1],
    ["credential script", 0xf0],
  ])("rút từ tài khoản mang mã băm stake của ví nhưng %s: không ký bằng khoá stake", async (_label, header) => {
    const a = await acct();
    const body = base();
    body.set(5, new Map([[Buffer.concat([Buffer.from([header]), Buffer.from(a.stakeKeyHashHex, "hex")]), 5_000_000]]));
    const s = summariseTx(tx(body), addressesOnly(a).ownAddressesHex, addressesOnly(a).held, 0);
    expect(s.foreignWithdrawals).toBe(1);
    expect(s.ownRewardKeyHashes).toEqual([]);
    expect(requiredKeysFor(tx(body), a, addressesOnly(a)).keyHashes).not.toContain(a.stakeKeyHashHex);
  });
});

/**
 * Vòng soát 3, đòn 1: tài sản thế chấp không trần ở đường KÝ. Trường 13 là một
 * UTxO 10.000 ADA của ví, không có trường 16; trang tự quyết script có lỗi hay
 * không, nên 10.000 ADA đó là tiền trang lấy được. Trước bản vá, màn hình in
 * con số và hàm ký vẫn ký.
 */
describe("tài sản thế chấp 10.000 ADA không có phần trả lại", () => {
  const OWN_BIG = "aa".repeat(32);
  const OWN_SMALL = "bb".repeat(32);

  it("cả màn hình lẫn hàm ký đều từ chối, cùng một khoá lỗi", async () => {
    const a = await acct();
    const mine = a.external[0]!.address;
    const view: WalletView = {
      ownAddressesHex: a.external.map((d) => addrHex(d.address)),
      held: new Map([
        [`${OWN_BIG}#0`, { address: mine, lovelace: BigInt(10_000_000_000), assets: new Map() }],
        [`${OWN_SMALL}#0`, { address: mine, lovelace: BigInt(3_000_000), assets: new Map() }],
      ]),
    };
    const body = new Map<number, unknown>([
      [0, [[Buffer.from(OWN_SMALL, "hex"), 0], [Buffer.from(THEIR_TXID, "hex"), 0]]],
      [1, [[Buffer.from(addrHex(mine), "hex"), 2_800_000]]],
      [2, 200_000],
      [11, Buffer.alloc(32, 1)],
      [13, [[Buffer.from(OWN_BIG, "hex"), 0]]],
    ]);
    expect(() => summariseTx(tx(body), view.ownAddressesHex, view.held, 0)).toThrow(
      expect.objectContaining({ key: "sign_foreign_collateral_over_cap" }),
    );
    expect(() => signForeignTx(tx(body), a, view, false)).toThrow(/^sign_foreign_collateral_over_cap: /);
    expect(() => signForeignTx(tx(body), a, view, true)).toThrow(/^sign_foreign_collateral_over_cap: /);
  });
});

/**
 * Vòng soát 3, đòn 3: script chạy cạnh một đầu vào không phải của ví. Script đó
 * có thể mở khoá tài sản cho bất kỳ ai mang chữ ký của khoá ví, nên chữ ký của
 * ví là thứ tiêu đầu vào lạ — mà giá trị của nó không nằm trong `net`. Không
 * chặn (claim LAMP đúng là hình này), nhưng bản tóm tắt phải đếm ra để màn
 * hình cảnh báo.
 *
 * Vòng soát 8: đếm cả khi KHÔNG thấy dấu Plutus. Native script (vd.
 * all[sig(pkh ví), after(slot)]) không cần redeemer, trường 11 hay 13, và mã
 * của nó có thể nằm trong reference script của một reference input (khoá 18),
 * nên witness set cũng không có khoá 1. Bản tóm tắt không biết địa chỉ của
 * đầu vào lạ, nên đếm mọi đầu vào không phải của ví.
 */
describe("đầu vào lạ (script hay không)", () => {
  const OWN_SMALL = "bb".repeat(32);
  const body = (mine: string, extra: [number, unknown][]) =>
    new Map<number, unknown>([
      [0, [[Buffer.from(OWN_SMALL, "hex"), 0], [Buffer.from(THEIR_TXID, "hex"), 7]]],
      [1, [[Buffer.from(addrHex(ATTACKER), "hex"), 1_002_000_000], [Buffer.from(addrHex(mine), "hex"), 2_000_000]]],
      [2, 300_000],
      ...extra,
    ]);
  const viewOf = (a: Account): WalletView => ({
    ownAddressesHex: a.external.map((d) => addrHex(d.address)),
    held: new Map([[`${OWN_SMALL}#0`, { address: a.external[0]!.address, lovelace: BigInt(3_000_000), assets: new Map() }]]),
  });
  const summary = (a: Account, b: Map<number, unknown>, witnesses: Map<number, unknown> = new Map()) =>
    summariseTx(Encoder.encode([b, witnesses, true, null]).toString("hex"), viewOf(a).ownAddressesHex, viewOf(a).held, 0);

  it("PoC3: script_data_hash + collateral + một đầu vào lạ: đếm 1, và vẫn ký (cảnh báo, không chặn)", async () => {
    const a = await acct();
    const mine = a.external[0]!.address;
    const pkh = (tyUtils.getAddressFromString(mine) as unknown as { paymentCredential: { hash: Buffer } }).paymentCredential.hash;
    const b = body(mine, [
      [11, Buffer.alloc(32, 2)],
      [13, [[Buffer.from(OWN_SMALL, "hex"), 0]]],
      [14, [pkh]],
    ]);
    const s = summary(a, b);
    expect(s.foreignInputs).toBe(1);
    expect(s.ownInputs).toBe(1);
    expect(s.totalInputs).toBe(2);
    expect(() => signForeignTx(tx(b), a, viewOf(a), true)).not.toThrow();
  });

  it("mỗi dấu hiệu script một mình đều đủ: redeemer, trường 11, trường 13", async () => {
    const a = await acct();
    const mine = a.external[0]!.address;
    expect(summary(a, body(mine, []), new Map([[5, [[0, 1, 0, [1, 1]]]]])).foreignInputs).toBe(1);
    expect(summary(a, body(mine, [[11, Buffer.alloc(32, 2)]])).foreignInputs).toBe(1);
    expect(summary(a, body(mine, [[13, [[Buffer.from(OWN_SMALL, "hex"), 0]]]])).foreignInputs).toBe(1);
  });

  it("không dấu Plutus vẫn đếm đầu vào lạ", async () => {
    const a = await acct();
    expect(summary(a, body(a.external[0]!.address, [])).foreignInputs).toBe(1);
  });

  it("native script qua reference input: không redeemer, không 11/13, witness rỗng — vẫn đếm, và ví vẫn ký", async () => {
    const a = await acct();
    const mine = a.external[0]!.address;
    // Khoá 18: reference input mang reference script (native) mở khoá đầu vào lạ.
    const b = body(mine, [[18, [[Buffer.alloc(32, 9), 0]]]]);
    expect(b.has(11) || b.has(13)).toBe(false);
    const s = summary(a, b);
    expect(s.foreignInputs).toBe(1);
    expect(s.ownInputs).toBe(1);
    expect(s.totalInputs).toBe(2);
    // Ví vẫn ký (cảnh báo, không chặn) — đúng vì thế màn hình phải nói ra.
    expect(() => signForeignTx(tx(b), a, viewOf(a), false)).not.toThrow();
  });

  it("mọi đầu vào đều của ví thì không đếm, có script hay không", async () => {
    const a = await acct();
    const mine = a.external[0]!.address;
    for (const extra of [[], [[11, Buffer.alloc(32, 2)]], [[18, [[Buffer.alloc(32, 9), 0]]]]] as [number, unknown][][]) {
      const b = body(mine, extra);
      b.set(0, [[Buffer.from(OWN_SMALL, "hex"), 0]]);
      b.set(1, [[Buffer.from(addrHex(mine), "hex"), 2_700_000]]);
      expect(summary(a, b).foreignInputs).toBe(0);
    }
  });
});
