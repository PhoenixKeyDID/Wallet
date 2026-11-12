// @vitest-environment happy-dom
/**
 * The wallet window a website opens, driven the way the worker drives it:
 * unlock with a real vault, then requests arriving on the port.
 *
 * Each case here was a dead end for a real dApp before it was fixed —
 * `getUtxos` refused, `signData` and `submitTx` parked on a screen whose
 * approve button could never be enabled, the wrong account answering, an
 * English string in the middle of a translated screen.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, act, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { Buffer } from "buffer";
import BigNumber from "bignumber.js";
import { Encoder } from "@stricahq/cbors";
import { utils as tyUtils, types as tyTypes } from "@stricahq/typhonjs";
import en from "../../../../locales/en/wallet.json";
import { DEFAULT_LOCK_TIMEOUT_MS } from "@/lib/keystore/session";
import { accountFromEntropy, allAddresses, primaryAddress, sealVault } from "@/lib/keystore";
import type { StoredWallet } from "@/lib/keystore/storage";
import { decodeUtxosToInputs } from "@/lib/cardano/tx";
import { baseAddress } from "@/lib/cardano/address";
import { bech32 } from "bech32";
import { verifyCip8 } from "./vendor/lamp-drip-pot/cip8";

const mocks = vi.hoisted(() => ({
  wallets: [] as unknown[],
  fetchUtxos: vi.fn(),
  submitTx: vi.fn(),
}));

vi.mock("@/lib/keystore/storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/keystore/storage")>()),
  vaultStore: () => ({
    list: async () => mocks.wallets,
    get: async (id: string) => mocks.wallets.find((w) => (w as StoredWallet).id === id),
    put: async () => {},
    remove: async () => {},
  }),
}));

vi.mock("@/lib/cardano/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/cardano/provider")>()),
  fetchUtxos: mocks.fetchUtxos,
  submitTx: mocks.submitTx,
}));

type Msg = { type: string; id?: string; origin?: string; result?: { ok: boolean; value?: unknown; error?: { code: number; info: string } } };
type FakePort = { sent: Msg[]; deliver(m: unknown): void; disconnected: boolean };
const ports: FakePort[] = [];

const ORIGIN = "https://dex.example";
const PASSWORD = "correct horse battery";
const ENTROPY = Uint8Array.from(Buffer.alloc(32, 9));
const OUTSIDER = baseAddress("ab".repeat(28), "cd".repeat(28), 0);

let Approve: typeof import("../../../../extension/src/approve").Approve;
let i18n: import("i18next").i18n;
let acct1Primary: string;
let acct0Primary: string;
let acct1Addresses: string[];
let acct1RewardHex: string;
let acct1StakeKeyHash: string;

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      connect: () => {
        let listener: (m: unknown) => void = () => {};
        const port: FakePort & Record<string, unknown> = {
          sent: [],
          disconnected: false,
          deliver: (m) => listener(m),
          postMessage: (m: unknown) => void port.sent.push(m as Msg),
          onMessage: { addListener: (cb: (m: unknown) => void) => void (listener = cb) },
          disconnect: () => void (port.disconnected = true),
        };
        ports.push(port);
        return port;
      },
    },
  };
  window.history.replaceState({}, "", `/approve.html?origin=${encodeURIComponent(ORIGIN)}`);
  const root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);

  const vault = await sealVault(ENTROPY, PASSWORD);
  const a0 = await accountFromEntropy(ENTROPY, 0, 0);
  const a1 = await accountFromEntropy(ENTROPY, 1, 0);
  acct0Primary = primaryAddress(a0);
  acct1Primary = primaryAddress(a1);
  acct1Addresses = allAddresses(a1);
  acct1RewardHex = Buffer.from(bech32.fromWords(bech32.decode(a1.rewardAddress, 1023).words)).toString("hex");
  acct1StakeKeyHash = a1.stakeKeyHashHex;
  mocks.wallets.push({
    id: "w1",
    label: "Main",
    vault,
    firstAddress: acct0Primary,
    network: 0,
    createdAt: "2026-11-01T00:00:00Z",
    // The person last used account 1 — that is where their money is.
    accountIndex: 1,
  } satisfies StoredWallet);

  const mod = await import("../../../../extension/src/approve");
  Approve = mod.Approve;
  i18n = (await import("../../../../extension/src/i18n")).i18n;
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  mocks.fetchUtxos.mockReset();
  mocks.submitTx.mockReset();
});

/** Render a fresh window, unlock it, and return the port it opened to the worker. */
async function unlocked() {
  const before = ports.length;
  // Importing the module also mounts its own copy into #root; query only ours.
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <Approve />
    </I18nextProvider>,
  );
  const view = Object.assign(within(container), { container });
  const pw = await view.findByPlaceholderText(en.local_password);
  fireEvent.change(pw, { target: { value: PASSWORD } });
  fireEvent.click(view.getByText(en.local_unlock_cta));
  await waitFor(() => expect(ports.length).toBe(before + 1), { timeout: 20_000 });
  const port = ports[before]!;
  expect(port.sent[0]).toEqual({ type: "hello", origin: ORIGIN });
  return { port, view };
}

async function ask(port: FakePort, id: string, method: string, params: unknown[]): Promise<Msg> {
  act(() => port.deliver({ type: "request", id, origin: ORIGIN, method, params }));
  let got: Msg | undefined;
  await waitFor(() => {
    got = port.sent.find((m) => m.type === "result" && m.id === id);
    expect(got).toBeDefined();
  });
  return got!;
}

const ourInputs = () => [
  {
    txId: "77".repeat(32),
    index: 1,
    amount: new BigNumber("5000000"),
    tokens: [],
    address: tyUtils.getAddressFromString(acct1Primary) as tyTypes.ShelleyAddress,
  },
];

/** A whole, already-signed-looking transaction: someone else's input, paying someone else. */
const SIGNED_TX = Encoder.encode([
  new Map<number, unknown>([
    [0, [[Buffer.from("11".repeat(32), "hex"), 0]]],
    [
      1,
      [[Buffer.from((tyUtils.getAddressFromString(OUTSIDER) as tyTypes.ShelleyAddress).getHex(), "hex"), 1_000_000]],
    ],
    [2, 200_000],
  ]),
  new Map(),
  true,
  null,
]).toString("hex");

describe("the wallet window opens the account the person last used", () => {
  it("shows account 1's address, not account 0's", async () => {
    const { view } = await unlocked();
    expect(view.container.textContent).toContain(acct1Primary);
    expect(view.container.textContent).not.toContain(acct0Primary);
  });
});

describe("getUtxos / getBalance", () => {
  it("answers with CBOR of exactly the inputs the signing path reads, for this account", async () => {
    mocks.fetchUtxos.mockResolvedValue(ourInputs());
    const { port } = await unlocked();
    const res = await ask(port, "u1", "getUtxos", [null, null]);
    expect(res.result?.ok).toBe(true);
    const back = decodeUtxosToInputs(res.result!.value as string[]);
    expect(back.map((i) => `${i.txId}#${i.index}:${i.amount.toFixed(0)}`)).toEqual([`${"77".repeat(32)}#1:5000000`]);
    // Same source as signing: the indexer, asked about this account's addresses.
    expect(mocks.fetchUtxos).toHaveBeenCalledWith(0, acct1Addresses);
  });

  it("`amount` the wallet covers answers the coins that cover it; one it cannot answers null", async () => {
    mocks.fetchUtxos.mockResolvedValue(ourInputs());
    const { port } = await unlocked();
    const covered = await ask(port, "u2", "getUtxos", ["1a000f4240", null]); // 1 ADA
    expect(decodeUtxosToInputs(covered.result!.value as string[]).map((i) => i.index)).toEqual([1]);
    const short = await ask(port, "u2b", "getUtxos", ["1a00989680", null]); // 10 ADA
    expect(short.result).toEqual({ ok: true, value: null });
    const junk = await ask(port, "u2c", "getUtxos", ["zz", null]);
    expect(junk.result).toMatchObject({ ok: false, error: { code: -1 } });
  });

  it("`paginate` past the end is a PaginateError carrying maxSize", async () => {
    mocks.fetchUtxos.mockResolvedValue(ourInputs());
    const { port } = await unlocked();
    const first = await ask(port, "p1", "getUtxos", [null, { page: 0, limit: 1 }]);
    expect((first.result!.value as string[]).length).toBe(1);
    const past = await ask(port, "p2", "getUtxos", [null, { page: 1, limit: 1 }]);
    expect(past.result).toMatchObject({ ok: false, error: { maxSize: 1 } });
    const bad = await ask(port, "p3", "getUtxos", [null, { page: -1, limit: 1 }]);
    expect(bad.result).toMatchObject({ ok: false, error: { code: -1 } });
  });

  it("getCollateral offers a pure-ADA coin up to 5 ADA, and refuses to put up more", async () => {
    mocks.fetchUtxos.mockResolvedValue(ourInputs());
    const { port } = await unlocked();
    const res = await ask(port, "c1", "getCollateral", [null]);
    expect(decodeUtxosToInputs(res.result!.value as string[]).map((i) => i.index)).toEqual([1]);
    const over = await ask(port, "c2", "getCollateral", [{ amount: "1a005b8d80" }]); // 6 ADA
    expect(over.result).toMatchObject({ ok: false, error: { code: -1 } });
  });

  it("getCollateral answers null when every coin carries tokens", async () => {
    const withToken = ourInputs().map((i) => ({
      ...i,
      tokens: [{ policyId: "ab".repeat(28), assetName: "", amount: new BigNumber(1) }],
    }));
    mocks.fetchUtxos.mockResolvedValue(withToken);
    const { port } = await unlocked();
    const res = await ask(port, "c3", "getCollateral", []);
    expect(res.result).toEqual({ ok: true, value: null });
  });

  it("a failed indexer read is an InternalError, not an empty wallet", async () => {
    mocks.fetchUtxos.mockRejectedValue(new Error("koios down"));
    const { port } = await unlocked();
    const res = await ask(port, "u3", "getUtxos", []);
    expect(res.result).toMatchObject({ ok: false, error: { code: -2 } });
  });

  it("getBalance answers the summed value as CBOR hex", async () => {
    mocks.fetchUtxos.mockResolvedValue(ourInputs());
    const { port } = await unlocked();
    const res = await ask(port, "b1", "getBalance", []);
    expect(res.result).toEqual({ ok: true, value: Encoder.encode(BigInt(5_000_000)).toString("hex") });
  });
});

describe("signData: the stake key signs what the screen shows, or the request is refused by code", () => {
  const MESSAGE = "drip-enroll/1\ncampaign: gst-preprod-1\nnetwork: Preprod";
  const payloadHex = () => Buffer.from(MESSAGE, "utf8").toString("hex");

  it("shows the key, the address and the message, and signs with the stake key LAMP's verifier accepts", async () => {
    const { port, view } = await unlocked();
    act(() => port.deliver({ type: "request", id: "d1", origin: ORIGIN, method: "signData", params: [acct1RewardHex, payloadHex()] }));
    await view.findByText(en.cip30_sign_data_key_stake);
    expect(view.getByTestId("sign-data-text").textContent).toBe(MESSAGE);
    expect(view.getByTestId("sign-data-hex").textContent).toBe(payloadHex());
    expect(port.sent.find((m) => m.id === "d1")).toBeUndefined();
    fireEvent.click(view.getByText(en.cip30_sign_data_cta));
    let got: Msg | undefined;
    await waitFor(() => {
      got = port.sent.find((m) => m.type === "result" && m.id === "d1");
      expect(got).toBeDefined();
    });
    expect(got!.result!.ok).toBe(true);
    const v = got!.result!.value as { signature: string; key: string };
    expect(() =>
      verifyCip8(v.signature, v.key, {
        rewardAddressHex: acct1RewardHex,
        stakeKeyHash: acct1StakeKeyHash,
        payload: new Uint8Array(Buffer.from(MESSAGE, "utf8")),
      }),
    ).not.toThrow();
  });

  it("Reject answers DataSignError.UserDeclined (3)", async () => {
    const { port, view } = await unlocked();
    act(() => port.deliver({ type: "request", id: "d2", origin: ORIGIN, method: "signData", params: [acct1RewardHex, payloadHex()] }));
    await view.findByText(en.cip30_sign_data_key_stake);
    fireEvent.click(view.getByText(en.cip30_reject));
    await waitFor(() => expect(port.sent.find((m) => m.id === "d2")?.result).toMatchObject({ ok: false, error: { code: 3 } }));
  });

  it("an address this wallet does not hold is ProofGeneration (1), at once, with no buttons", async () => {
    const { port, view } = await unlocked();
    const res = await ask(port, "d3", "signData", [OUTSIDER, payloadHex()]);
    expect(res.result).toMatchObject({ ok: false, error: { code: 1 } });
    expect(view.queryByText(en.cip30_reject)).toBeNull();
  });

  it("a script reward address is AddressNotPK (2)", async () => {
    const { port } = await unlocked();
    const res = await ask(port, "d4", "signData", ["f0" + "11".repeat(28), payloadHex()]);
    expect(res.result).toMatchObject({ ok: false, error: { code: 2 } });
  });

  it("account 0's reward address is not account 1's to sign for", async () => {
    const { port } = await unlocked();
    const a0 = await accountFromEntropy(ENTROPY, 0, 0);
    const res = await ask(port, "d5", "signData", [a0.rewardAddress, payloadHex()]);
    expect(res.result).toMatchObject({ ok: false, error: { code: 1 } });
  });
});

describe("submitTx is described, then sent — or refused with TxSendError.Refused", () => {
  it("the Send button becomes usable and broadcasts the exact bytes", async () => {
    mocks.fetchUtxos.mockResolvedValue(ourInputs());
    mocks.submitTx.mockResolvedValue("ab".repeat(32));
    const { port, view } = await unlocked();
    act(() => port.deliver({ type: "request", id: "s1", origin: ORIGIN, method: "submitTx", params: [SIGNED_TX] }));
    const send = await view.findByText(en.cip30_submit_cta);
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(port.sent.find((m) => m.id === "s1")).toBeDefined());
    expect(mocks.submitTx).toHaveBeenCalledWith(0, SIGNED_TX);
    expect(port.sent.find((m) => m.id === "s1")!.result).toEqual({ ok: true, value: "ab".repeat(32) });
  });

  it("Reject answers TxSendError.Refused (1), not 2 — which for submitTx means Failure", async () => {
    mocks.fetchUtxos.mockResolvedValue(ourInputs());
    const { port, view } = await unlocked();
    act(() => port.deliver({ type: "request", id: "s2", origin: ORIGIN, method: "submitTx", params: [SIGNED_TX] }));
    fireEvent.click(await view.findByText(en.cip30_reject));
    await waitFor(() => expect(port.sent.find((m) => m.id === "s2")).toBeDefined());
    expect(port.sent.find((m) => m.id === "s2")!.result).toMatchObject({ ok: false, error: { code: 1 } });
    expect(mocks.submitTx).not.toHaveBeenCalled();
  });

  it("a node rejection comes back as TxSendError.Failure with the node's reason", async () => {
    mocks.fetchUtxos.mockResolvedValue(ourInputs());
    mocks.submitTx.mockRejectedValue(new Error("BadInputsUTxO"));
    const { port, view } = await unlocked();
    act(() => port.deliver({ type: "request", id: "s3", origin: ORIGIN, method: "submitTx", params: [SIGNED_TX] }));
    const send = await view.findByText(en.cip30_submit_cta);
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(port.sent.find((m) => m.id === "s3")).toBeDefined());
    expect(port.sent.find((m) => m.id === "s3")!.result).toMatchObject({
      ok: false,
      error: { code: 2, info: expect.stringContaining("BadInputsUTxO") },
    });
  });
});

describe("the connected screen is translated", () => {
  it("prints the address count through i18n, not a hard-coded English word", async () => {
    const { view } = await unlocked();
    await waitFor(() => expect(view.container.textContent).toContain(en.cip30_connected));
    expect(view.container.textContent).toContain(
      en.cip30_address_count.replace("{{n}}", String(acct1Addresses.length)),
    );
  });
});

describe("signTx: a signing step that fails is TxSignError.ProofGeneration (1)", () => {
  it("answers 1 with the reason, not UserDeclined (2) — the person did approve", async () => {
    // The first read describes the transaction; the second, inside signing, fails.
    mocks.fetchUtxos.mockResolvedValueOnce(ourInputs()).mockRejectedValueOnce(new Error("koios down"));
    const { port, view } = await unlocked();
    act(() => port.deliver({ type: "request", id: "t1", origin: ORIGIN, method: "signTx", params: [SIGNED_TX] }));
    const approve = await view.findByText(en.cip30_approve);
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(approve);
    await waitFor(() => expect(port.sent.find((m) => m.id === "t1")).toBeDefined());
    expect(port.sent.find((m) => m.id === "t1")!.result).toMatchObject({
      ok: false,
      error: { code: 1, info: expect.stringContaining("koios down") },
    });
  });
});

describe("enable: Reject is APIError.Refused (-3), the code CIP-30 gives a declined connection", () => {
  it("answers -3, not TxSignError.UserDeclined (2)", async () => {
    const { port, view } = await unlocked();
    act(() => port.deliver({ type: "request", id: "e1", origin: ORIGIN, method: "enable", params: [] }));
    fireEvent.click(await view.findByText(en.cip30_reject));
    await waitFor(() => expect(port.sent.find((m) => m.id === "e1")).toBeDefined());
    expect(port.sent.find((m) => m.id === "e1")!.result).toMatchObject({ ok: false, error: { code: -3 } });
  });
});

describe("an idle lock closes the port the unlocked account answered on", () => {
  it("disconnects, and a request still arriving on that port is refused, not served by a wiped account", async () => {
    mocks.fetchUtxos.mockResolvedValue(ourInputs());
    const { port, view } = await unlocked();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Restart the idle timer under fake time, then let it run out.
      fireEvent.mouseDown(window);
      act(() => void vi.advanceTimersByTime(DEFAULT_LOCK_TIMEOUT_MS + 1));
    } finally {
      vi.useRealTimers();
    }
    await view.findByPlaceholderText(en.local_password);
    expect(port.disconnected).toBe(true);
    const res = await ask(port, "r1", "getUtxos", []);
    expect(res.result).toMatchObject({ ok: false, error: { code: -3, info: en.cip30_window_locked } });
    expect(mocks.fetchUtxos).not.toHaveBeenCalled();
  });
});
