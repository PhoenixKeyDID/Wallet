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
import { signForeignTx } from "../signForeign";
import { summariseTx } from "../../cardano/txSummary";
import { baseAddress, type PhoenixNetwork } from "../../cardano/address";

const NETWORK: PhoenixNetwork = 0;
const ENTROPY = Uint8Array.from(Buffer.alloc(32, 7));
const ATTACKER = baseAddress("ab".repeat(28), "cd".repeat(28), NETWORK);
const THEIR_TXID = "11".repeat(32);

let account: Account;
const acct = async () => (account ??= await accountFromEntropy(ENTROPY, 0, NETWORK));

const addrHex = (bech32: string) =>
  (tyUtils.getAddressFromString(bech32) as tyTypes.ShelleyAddress).getHex();

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
    expect(() => signForeignTx(tx(body), a, new Map(), false)).toThrow(/sign_unjustified_signer/);
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
    // cho nó an toàn là màn hình phải nói ra 500 ADA — bài ngay dưới.
    expect(() => signForeignTx(tx(body), a, new Map(), false)).not.toThrow();
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
    expect(() => signForeignTx(tx(body), a, new Map(), false)).toThrow();
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
    expect(() => signForeignTx(tx(body), a, new Map(), false)).toThrow();
  });
});
