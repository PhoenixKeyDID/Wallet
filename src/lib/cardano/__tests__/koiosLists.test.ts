/**
 * The three list reads that outgrew one Koios response.
 *
 * Measured 2026-11-02 on Preview with `Prefer: count=exact`: `/pool_list`
 * 1295 rows, `/drep_list` 15566, `/proposal_list` 1583 — each past the
 * 1000-row cap, so each unfiltered, unpaged read was refused as truncated and
 * pool search, dRep search and the vote list showed an error on every try.
 *
 * The fake below answers the way PostgREST does: it applies `eq.` / `ilike.`
 * filters, `offset` and `limit`, never returns more than 1000 rows, and reports
 * `content-range` with the exact matching total. The row the user is looking
 * for is always placed past row 1000, where an unpaged read never reaches.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { koios, koiosAll, koiosContains, KoiosTruncatedError } from "../provider";
import { searchPools } from "../staking";
import { listDReps, listGovActions } from "../governance";

const PREVIEW = 2 as const;
const CAP = 1000;

type Row = Record<string, unknown>;

function matches(row: Row, column: string, op: string): boolean {
  const value = String(row[column] ?? "");
  if (op.startsWith("eq.")) return value === op.slice(3);
  if (op.startsWith("ilike.")) {
    const pattern = op.slice(6).replace(/\*/g, "");
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  throw new Error(`fake PostgREST: unsupported filter ${column}=${op}`);
}

/** Serves `lists[path]` for GET and `posts[path]` for POST; records every URL. */
function fakeKoios(lists: Record<string, Row[]>, posts: Record<string, (body: any) => Row[]> = {}) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      urls.push(input);
      const url = new URL(input);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      if (init?.method === "POST") {
        const handler = posts[path];
        if (!handler) throw new Error(`fake PostgREST: no POST ${path}`);
        return Response.json(handler(JSON.parse(String(init.body))));
      }
      const all = lists[path];
      if (!all) throw new Error(`fake PostgREST: no GET ${path}`);
      let rows = all;
      for (const [k, v] of url.searchParams) {
        if (k === "limit" || k === "offset" || k === "order") continue;
        rows = rows.filter((r) => matches(r, k, v));
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? CAP), CAP);
      const page = rows.slice(offset, offset + limit);
      const range = page.length ? `${offset}-${offset + page.length - 1}/${rows.length}` : `*/${rows.length}`;
      return new Response(JSON.stringify(page), {
        status: page.length < rows.length ? 206 : 200,
        headers: { "content-type": "application/json", "content-range": range },
      });
    }),
  );
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

const GST = "pool1500euld27dqfajdjmgv0j44e7sdxlt8uyu5k6takfc6mc5x9jlf";

function poolList(): Row[] {
  const rows: Row[] = Array.from({ length: 1295 }, (_, i) => ({
    pool_id_bech32: `pool1filler${String(i).padStart(5, "0")}`,
    ticker: `P${i}`,
    pool_status: "registered",
  }));
  rows[1200] = { pool_id_bech32: GST, ticker: "GST", pool_status: "registered" };
  rows[1201] = { pool_id_bech32: "pool1retiredgst", ticker: "GSTX", pool_status: "retired" };
  return rows;
}

const poolInfo = (body: { _pool_bech32_ids: string[] }) =>
  body._pool_bech32_ids.map((id) => ({
    pool_id_bech32: id,
    ticker: id === GST ? "GST" : "?",
    pool_status: "registered",
    meta_json: { ticker: id === GST ? "GST" : "?", name: "Green Sun" },
    live_stake: "1000",
    live_saturation: "0.01",
    margin: 0.02,
    fixed_cost: "340000000",
    pledge: "0",
  }));

describe("searchPools — the pool past row 1000 is found", () => {
  it("finds a pool by ticker when the list is longer than one response", async () => {
    const urls = fakeKoios({ "/pool_list": poolList() }, { "/pool_info": poolInfo });
    const found = await searchPools(PREVIEW, "gst");
    expect(found.map((p) => p.poolId)).toEqual([GST]);
    expect(found[0].name).toBe("Green Sun");
    const listUrl = new URL(urls[0]);
    expect(listUrl.searchParams.get("ticker")).toBe("ilike.*gst*");
    expect(listUrl.searchParams.get("pool_status")).toBe("eq.registered");
  });

  it("finds a pool by its id", async () => {
    const urls = fakeKoios({ "/pool_list": poolList() }, { "/pool_info": poolInfo });
    const found = await searchPools(PREVIEW, GST);
    expect(found.map((p) => p.poolId)).toEqual([GST]);
    expect(new URL(urls[0]).searchParams.get("pool_id_bech32")).toBe(`ilike.*${GST}*`);
  });

  it("treats a query of only wildcards as empty and asks nothing", async () => {
    const urls = fakeKoios({ "/pool_list": poolList() });
    await expect(searchPools(PREVIEW, " *% ")).resolves.toEqual([]);
    expect(urls).toEqual([]);
  });
});

describe("listDReps — filtered on the server, not after a capped read", () => {
  it("finds a registered dRep that sits past row 1000 and skips unregistered ones", async () => {
    const dreps: Row[] = Array.from({ length: 15566 }, (_, i) => ({
      drep_id: `drep1filler${i}`,
      hex: "00",
      has_script: false,
      registered: i % 2 === 0,
    }));
    dreps[14000] = { drep_id: "drep1wantedone", hex: "11", has_script: false, registered: true };
    dreps[14001] = { drep_id: "drep1wantedtwo", hex: "22", has_script: false, registered: false };
    const urls = fakeKoios(
      { "/drep_list": dreps },
      {
        "/drep_info": (b: { _drep_ids: string[] }) =>
          b._drep_ids.map((id) => ({ drep_id: id, amount: "5", active: true })),
      },
    );
    const found = await listDReps(PREVIEW, "wanted");
    expect(found.map((d) => d.drepId)).toEqual(["drep1wantedone"]);
    expect(found[0].votingPower).toBe("5");
    expect(new URL(urls[0]).searchParams.get("registered")).toBe("eq.true");
  });
});

describe("listGovActions — every page, not the first", () => {
  it("returns an open action that only the second page holds", async () => {
    const closed = { ratified_epoch: null, enacted_epoch: 10, dropped_epoch: null, expired_epoch: null };
    const open = { ratified_epoch: null, enacted_epoch: null, dropped_epoch: null, expired_epoch: null };
    const rows: Row[] = Array.from({ length: 1583 }, (_, i) => ({
      proposal_id: `gov_action1x${i}`,
      proposal_tx_hash: i.toString(16).padStart(64, "0"),
      proposal_index: 0,
      proposal_type: "InfoAction",
      expiration: 100,
      meta_json: null,
      ...(i === 1500 ? open : closed),
    }));
    const urls = fakeKoios({ "/proposal_list": rows });
    const all = await listGovActions(PREVIEW);
    expect(all).toHaveLength(1583);
    expect(all.filter((a) => a.isOpen).map((a) => a.proposalId)).toEqual(["gov_action1x1500"]);
    expect(urls.map((u) => new URL(u).searchParams.get("offset"))).toEqual([null, "1000"]);
    for (const u of urls) expect(new URL(u).searchParams.get("order")).toBeTruthy();
  });
});

describe("koios / koiosAll — paging contract", () => {
  it("accepts a later page that holds everything past its offset", async () => {
    fakeKoios({ "/proposal_list": Array.from({ length: 1583 }, (_, i) => ({ i })) });
    const page = await koios<Row[]>(PREVIEW, "/proposal_list", undefined, {
      limit: CAP,
      order: "i.asc",
      offset: CAP,
    });
    expect(page).toHaveLength(583);
  });

  it("refuses a later page that came back short of what lies past its offset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("[]", { status: 206, headers: { "content-range": "1000-1499/1583" } }),
      ),
    );
    await expect(
      koios(PREVIEW, "/proposal_list", undefined, { limit: CAP, order: "i.asc", offset: CAP }),
    ).rejects.toThrow(/500 of 583/);
  });

  it("refuses a list still going at its ceiling instead of returning the part it read", async () => {
    fakeKoios({ "/drep_list": Array.from({ length: 2500 }, (_, i) => ({ i })) });
    await expect(koiosAll(PREVIEW, "/drep_list", "i.asc", undefined, 2000)).rejects.toBeInstanceOf(
      KoiosTruncatedError,
    );
  });

  it("strips wildcards from a contains filter, and refuses one that is only wildcards", () => {
    expect(koiosContains("g*s%t")).toBe("ilike.*gst*");
    expect(() => koiosContains("**")).toThrow();
  });
});
