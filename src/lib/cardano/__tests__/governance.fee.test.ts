/**
 * Phí giao dịch quản trị, đo trên giao dịch ĐÃ KÝ dựng thật.
 *
 * Bài kiểm sẵn có (`governance.test.ts`) so `built.fee` với
 * `transaction.calculateFee()`. Đó là so với CHÍNH bộ ước lượng đang bị nghi
 * đếm thiếu — nó bắt được lỗi `setFee(0)` ngày trước, nhưng nó không thể trả
 * lời câu mà #6 hỏi, vì cả hai vế đều là lời của typhon.
 *
 * Luật của node thì không nhắc tới typhon:
 *
 *     minFee = minFeeA × size(giao dịch ĐÃ KÝ) + minFeeB
 *
 * Nên bài dưới đây dựng đúng thứ đó: lấy thân giao dịch chưa ký, ghép vào một
 * bộ nhân chứng gồm N vkey giả, mã hoá lại, rồi đo. Không tin con số nào của
 * typhon, kể cả 101.
 */
import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { address as tyAddress, types as tyTypes, Transaction } from "@stricahq/typhonjs";
import { Decoder, Encoder } from "@stricahq/cbors";
import { buildDRepRegistration, buildDRepDeRegistration } from "../governance";

const DREP_HASH = "ab".repeat(28);
const STAKE_HASH = "cd".repeat(28);
const PAY_HASH = "ef".repeat(28);
const PAY_HASH_2 = "12".repeat(28);
const NET = tyTypes.NetworkId.TESTNET;

const addrWith = (payHash: string) =>
  new tyAddress.BaseAddress(
    NET,
    { hash: Buffer.from(payHash, "hex"), type: tyTypes.HashType.ADDRESS },
    { hash: Buffer.from(STAKE_HASH, "hex"), type: tyTypes.HashType.ADDRESS },
  );
const baseAddr = addrWith(PAY_HASH);
const otherAddr = addrWith(PAY_HASH_2);

/** Tham số preprod/mainnet thật — 4444 lovelace trong chú thích là theo A=44. */
const MIN_FEE_A = 44;
const MIN_FEE_B = 155381;
const protocolParams: tyTypes.ProtocolParams = {
  minFeeA: new BigNumber(MIN_FEE_A),
  minFeeB: new BigNumber(MIN_FEE_B),
  stakeKeyDeposit: new BigNumber(2000000),
  utxoCostPerByte: new BigNumber(4310),
  collateralPercent: new BigNumber(150),
  priceSteps: new BigNumber(0.0000721),
  priceMem: new BigNumber(0.0577),
  maxTxSize: 16384,
  maxValueSize: 5000,
  minFeeRefScriptCostPerByte: new BigNumber(15),
};

const input = (lovelace: string, addr = baseAddr, index = 0): tyTypes.Input =>
  ({
    txId: "aa".repeat(32),
    index,
    amount: new BigNumber(lovelace),
    tokens: [],
    address: addr,
  }) as tyTypes.Input;

const deposit = new BigNumber(500_000_000);
const ctx = { protocolParams, ttl: 1000, changeAddress: baseAddr };

/**
 * Ghép N nhân chứng vkey giả vào thân chưa ký và trả kích thước ĐÃ KÝ.
 *
 * Khoá và chữ ký giả nhưng ĐỦ DÀI THẬT (32 và 64 byte), và đó là toàn bộ điều
 * kích thước phụ thuộc — CBOR mã hoá độ dài, không mã hoá nội dung. Một chữ ký
 * thật cho ra đúng số byte này.
 */
function signedSize(unsignedCbor: string, witnessCount: number): number {
  const tx = Decoder.decode(Buffer.from(unsignedCbor, "hex")).value as unknown[];
  const vkeys = Array.from({ length: witnessCount }, (_, i) => [
    Buffer.alloc(32, i + 1),
    Buffer.alloc(64, i + 1),
  ]);
  const signed = [tx[0], new Map<number, unknown>([[0, vkeys]]), tx[2], tx[3]];
  return Encoder.encode(signed).length;
}

/** Số nhân chứng typhon đã tính, suy ngược từ phí nó báo. */
function witnessesTyphonAssumed(unsignedCbor: string, estimatedFee: BigNumber): number {
  const estBytes = (BigInt(estimatedFee.toString()) - BigInt(MIN_FEE_B)) / BigInt(MIN_FEE_A);
  const bodyBytes = BigInt(Buffer.from(unsignedCbor, "hex").length);
  // 101 byte mỗi nhân chứng, cộng ~2 byte khung của chính bộ nhân chứng.
  return Number((estBytes - bodyBytes) / BigInt(101));
}

describe("một nhân chứng vkey là ĐÚNG 101 byte", () => {
  it("đo bằng cách mã hoá một cái, không nhận con số trong chú thích", () => {
    const empty = Encoder.encode([new Map<number, unknown>()]).length;
    const one = Encoder.encode([
      new Map<number, unknown>([[0, [[Buffer.alloc(32, 1), Buffer.alloc(64, 1)]]]]),
    ]).length;
    // Chênh lệch = 1 nhân chứng + khung của khoá map và mảng bọc nó.
    expect(one - empty).toBeGreaterThanOrEqual(101);
    expect(one - empty).toBeLessThanOrEqual(105);

    // Và nhân chứng thứ hai tốn đúng 101, không kèm khung nào nữa.
    const two = Encoder.encode([
      new Map<number, unknown>([
        [0, [
          [Buffer.alloc(32, 1), Buffer.alloc(64, 1)],
          [Buffer.alloc(32, 2), Buffer.alloc(64, 2)],
        ]],
      ]),
    ]).length;
    expect(two - one).toBe(101);
  });
});

describe("phí phủ được luật của node trên giao dịch ĐÃ KÝ (#6)", () => {
  // [tên, dựng, số nhân chứng mà giao dịch THẬT SỰ đòi]
  //
  // Số nhân chứng suy ra từ chính giao dịch, không từ typhon: một khoá thanh
  // toán cho mỗi credential KHÁC NHAU trong các input, cộng một khoá dRep cho
  // chứng chỉ. Khoá stake KHÔNG cần cho DREP_REG/DREP_DE_REG.
  const cases: Array<[string, () => ReturnType<typeof buildDRepRegistration>, number]> = [
    [
      "DREP_REG, 1 input",
      () => buildDRepRegistration({ drepKeyHash: Buffer.from(DREP_HASH, "hex"), deposit, ...ctx, inputs: [input("600000000")] }),
      2,
    ],
    [
      "DREP_REG, 2 input cùng credential",
      () => buildDRepRegistration({ drepKeyHash: Buffer.from(DREP_HASH, "hex"), deposit, ...ctx, inputs: [input("300000000"), input("300000000", baseAddr, 1)] }),
      2,
    ],
    [
      "DREP_REG, 2 input khác credential",
      () => buildDRepRegistration({ drepKeyHash: Buffer.from(DREP_HASH, "hex"), deposit, ...ctx, inputs: [input("300000000"), input("300000000", otherAddr, 1)] }),
      3,
    ],
    [
      "DREP_DE_REG, 1 input",
      () => buildDRepDeRegistration({ drepKeyHash: Buffer.from(DREP_HASH, "hex"), deposit, ...ctx, inputs: [input("10000000")] }),
      2,
    ],
  ];

  for (const [name, build, requiredWitnesses] of cases) {
    it(`${name}: phí ≥ minFeeA × kích-thước-đã-ký + minFeeB`, () => {
      const built = build();
      const size = signedSize(built.unsignedCbor, requiredWitnesses);
      const nodeMinFee = BigInt(MIN_FEE_A) * BigInt(size) + BigInt(MIN_FEE_B);
      expect(BigInt(built.fee) >= nodeMinFee).toBe(true);
    });

    it(`${name}: typhon tính ĐÚNG ${requiredWitnesses} nhân chứng, không thiếu`, () => {
      const built = build();
      const est = built.transaction.calculateFee();
      // Đây là điều chú thích cũ nói ngược: typhon KHÔNG bỏ sót khoá của chứng
      // chỉ. Bài này đỏ nếu một bản typhon sau này bắt đầu đếm thiếu — lúc đó
      // biên một-nhân-chứng chuyển từ "dư ra" thành "đang che một lỗi", và đó
      // là thứ phải biết chứ không phải thứ để yên.
      expect(witnessesTyphonAssumed(built.unsignedCbor, est)).toBe(requiredWitnesses);
    });

    it(`${name}: ước lượng của typhon khớp CHÍNH XÁC kích thước đã ký`, () => {
      const built = build();
      const est = BigInt(built.transaction.calculateFee().toString());
      const estBytes = (est - BigInt(MIN_FEE_B)) / BigInt(MIN_FEE_A);
      expect(Number(estBytes)).toBe(signedSize(built.unsignedCbor, requiredWitnesses));
    });
  }

  it("biên dư ra đúng một nhân chứng, và nó bị TIÊU chứ không hoàn lại", () => {
    const built = buildDRepRegistration({
      drepKeyHash: Buffer.from(DREP_HASH, "hex"), deposit, ...ctx, inputs: [input("600000000")],
    });
    const size = signedSize(built.unsignedCbor, 2);
    const nodeMinFee = BigInt(MIN_FEE_A) * BigInt(size) + BigInt(MIN_FEE_B);
    expect(BigInt(built.fee) - nodeMinFee).toBe(BigInt(MIN_FEE_A) * BigInt(101)); // 4444

    // Chú thích cũ ghi phần dư "comes back as change". Không: trên đường cân
    // tay này change = Σinput − deposit − fee, nên mỗi lovelace phí thêm là một
    // lovelace change bớt đi. Bài này ghim đúng chiều đó.
    const inputTotal = new BigNumber("600000000");
    const changeOut = built.transaction
      .getOutputs()
      .reduce((sum, o) => sum.plus(o.amount), new BigNumber(0));
    expect(changeOut.toString()).toBe(
      inputTotal.minus(deposit).minus(new BigNumber(built.fee)).toString(),
    );
  });
});
