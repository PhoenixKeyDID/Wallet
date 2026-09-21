import { describe, it, expect } from "vitest";
import { assetLabel, assetNameOnly, policyIdShort } from "../provider";

/**
 * A token's name is written by whoever minted it, and minting is open to
 * everyone. So a name is a claim, not an identifier — the only thing that
 * tells two assets apart is the (policy id, asset name) pair.
 *
 * These tests are written against that property rather than against any
 * particular spelling of the output. A test asserting the label contains
 * "…" or a "·" would pass on a screen that shows the right characters in the
 * wrong order, and would fail on a redesign that changes nothing that
 * matters. What matters is: can a reader of this string tell two assets
 * apart, and does a blank-looking name stay visible.
 */

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

// Three assets display `tLAMP` on preprod. Two of them are enough to test with.
const LAMP_REAL = "8169b76cdaba83cf7c9ae32ebd2bb3a58aa215c7dc0b62c8f5e268dd";
const LAMP_LOOKALIKE = "0000000000000000000000000000000000000000000000000000dead";
const TLAMP_NAME = hex("tLAMP");

describe("một tên token không phải một định danh", () => {
  it("hai policy id khác nhau mang CÙNG tên thì đọc ra hai chuỗi khác nhau", () => {
    const a = assetLabel({ policyId: LAMP_REAL, assetNameHex: TLAMP_NAME });
    const b = assetLabel({ policyId: LAMP_LOOKALIKE, assetNameHex: TLAMP_NAME });

    expect(assetNameOnly(TLAMP_NAME)).toBe("tLAMP");
    expect(a).not.toBe(b);
  });

  it("phần phân biệt lấy từ policy id, không phải từ một bộ đếm hay thứ tự", () => {
    // Đổi thứ tự gọi không được đổi kết quả: nhãn là hàm của cặp, không phải
    // của ngữ cảnh gọi. Một bản hiện thực đánh số "token #1 / #2" sẽ trượt ca
    // này, và nó trượt đúng chỗ nguy — hai màn hình khác nhau đánh số khác nhau.
    const first = assetLabel({ policyId: LAMP_LOOKALIKE, assetNameHex: TLAMP_NAME });
    const again = assetLabel({ policyId: LAMP_LOOKALIKE, assetNameHex: TLAMP_NAME });
    expect(again).toBe(first);
    expect(first).toContain(policyIdShort(LAMP_LOOKALIKE));
    expect(first).not.toContain(policyIdShort(LAMP_REAL));
  });

  it("một token tự đặt tên `ADA` vẫn phân biệt được với ADA thật", () => {
    // ADA thật không có policy id và không đi qua hàm này. Điều cần ghim là
    // token giả không bao giờ in ra một chuỗi trơ đọc y như đơn vị của mạng.
    const fake = assetLabel({ policyId: LAMP_LOOKALIKE, assetNameHex: hex("ADA") });
    expect(fake).not.toBe("ADA");
    expect(fake.startsWith("ADA ")).toBe(true);
    expect(fake).toContain(policyIdShort(LAMP_LOOKALIKE));
  });
});

describe("tên không hiện được thì phải lộ ra, không được biến thành ô trống", () => {
  it("tên toàn dấu cách rơi về hex thay vì in ra khoảng trắng", () => {
    // HTML gộp dãy dấu cách, nên một tên `"   "` hiện ra đúng bằng không có gì
    // — người đọc hiểu thành "token chưa đặt tên" chứ không hiểu thành
    // "token đặt tên để trông như chưa đặt tên".
    const blank = hex("   ");
    expect(assetNameOnly(blank)).toBe(blank);
  });

  it("tên rỗng hoàn toàn cũng rơi về hex", () => {
    expect(assetNameOnly("")).toBe("");
  });

  it("byte không in được rơi về hex, không rơi về ký tự thay thế", () => {
    // `Buffer.toString("utf8")` biến byte hỏng thành U+FFFD. Hai tên hỏng khác
    // nhau sẽ cùng ra một dãy U+FFFD — tức hai token khác nhau trông giống hệt.
    const bad = "ff00ff";
    expect(assetNameOnly(bad)).toBe(bad);
  });

  it("giữ nguyên tên có dấu cách ở mép, vì phần phân biệt nằm ở policy id", () => {
    // `"LAMP "` và `"LAMP"` hiện ra như nhau trong HTML. Hàm này không cố sửa
    // điều đó — nó không sửa được, và một bản vá ở đây sẽ đẻ ra tên bị cắt.
    // Chỗ chặn ca này là policy id đứng cạnh, nên ca này ghim rằng tên KHÔNG
    // bị đụng vào, để người đọc sau không tưởng là đã có phép làm sạch.
    expect(assetNameOnly(hex("LAMP "))).toBe("LAMP ");
    expect(assetLabel({ policyId: LAMP_REAL, assetNameHex: hex("LAMP ") })).not.toBe(
      assetLabel({ policyId: LAMP_LOOKALIKE, assetNameHex: hex("LAMP ") }),
    );
  });
});

describe("policy id không bỏ được ở chỗ chỉ có một dòng", () => {
  it("nhãn mang CẢ tên lẫn policy id, không mang mỗi một nửa", () => {
    // Cổng thật của phát hiện này nằm ở trình biên dịch: `assetLabel` nhận một
    // đối tượng có HAI trường bắt buộc, nên một màn hình mới bỏ policy id là
    // lỗi dịch chứ không phải một mục trong danh sách soát.
    //
    // Bản trước dùng hai tham số vị trí và ghim `assetLabel.length === 2`. Phép
    // đo đó đúng với thứ nó đo, nhưng thứ nó đo không đủ: cả hai tham số đều là
    // `string`, nên trình biên dịch không phân biệt được chúng. ĐO ĐƯỢC trên
    // chính nhánh này — đổi một chỗ gọi thành `assetLabel(a.assetNameHex,
    // a.policyId)` thì `tsc --noEmit` SẠCH và 700/700 test XANH. Tức cổng chặn
    // được việc BỎ QUÊN nhưng không chặn được việc ĐẢO, và cái sau cho ra đúng
    // thứ hàm này sinh ra để ngăn: một chuỗi không phải tên tài sản, đứng cạnh
    // một mảnh không phải policy id của nó.
    //
    // Trường có tên thì trình biên dịch phân biệt được, nên cả hai lối đều là
    // lỗi dịch. Ca dưới đây ghim phần mà kiểu không nói hộ: nhãn thật sự chứa
    // cả hai nửa, chứ không phải chỉ một nửa được nối thêm dấu chấm.
    const label = assetLabel({ policyId: LAMP_REAL, assetNameHex: TLAMP_NAME });
    expect(label).toContain(assetNameOnly(TLAMP_NAME));
    expect(label).toContain(policyIdShort(LAMP_REAL));
  });

  it("nửa tên trơ có tên hàm nói rõ nó là nửa tên trơ", () => {
    // `assetNameOnly` được phép trả về tên trần, nhưng chỉ ở nơi policy id đã
    // hiện ở dòng bên cạnh. Ghim rằng hai hàm KHÔNG trả cùng một thứ, để một
    // lần "dọn trùng lặp" sau này không gộp chúng lại làm một.
    expect(assetNameOnly(TLAMP_NAME)).not.toBe(
      assetLabel({ policyId: LAMP_REAL, assetNameHex: TLAMP_NAME }),
    );
  });
});
