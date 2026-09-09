/**
 * The `common` namespace, supplied by this host.
 *
 * `src/lib/api.ts` builds `userMessageKey` as `errors.<code>`, and those strings
 * belong to the **host**, not to this module — the web app reads them from
 * `PhoenixKey-Frontend/public/locales/<lng>/common.json`. The extension is the
 * other host, and it was supplying none, so every unrecognised failure in the
 * packaged wallet printed the literal string `errors.generic` at the user.
 *
 * They live here rather than in `locales/`, and that placement is the point.
 * `scripts/check-locales.mjs` refuses a nested group inside a module locale file,
 * because host string groups copied into this module is exactly how a stale copy
 * of the host's own keys once started overriding the host's live strings
 * depending on load order. Putting `errors.*` into `wallet.json` would have been
 * that bug again, and the gate said so.
 *
 * So: the module owns `wallet` and `night`; each host owns `common`. Two hosts,
 * two copies, and they are copies of a **contract** rather than of content — the
 * only shared thing is the key name, which `src/lib/api.ts:35` defines.
 *
 * Deliberately minimal. Only `generic` is a literal in this repo; every other
 * `errors.<code>` comes from a backend code at runtime, and inventing text for
 * codes nobody has seen would be writing a reassuring sentence about a failure
 * this wallet has never met.
 */
export const COMMON = {
  en: {
    errors: {
      generic:
        "Something went wrong and the wallet could not say what. Your funds did not move. " +
        "Try again — if it keeps happening, the chain data source is more likely down than your wallet.",
    },
  },
  vi: {
    errors: {
      generic:
        "Có chuyện không ổn mà ví không nói được là chuyện gì. Tiền của bạn không bị chuyển đi. " +
        "Thử lại — nếu vẫn vậy thì nhiều khả năng nguồn dữ liệu chuỗi đang hỏng, không phải ví của bạn.",
    },
  },
  ja: {
    errors: {
      generic:
        "問題が発生しましたが、ウォレットは原因を特定できませんでした。資金は動いていません。" +
        "再試行してください。繰り返す場合は、ウォレットではなくチェーンのデータ元が停止している可能性があります。",
    },
  },
  zh: {
    errors: {
      generic:
        "出了问题，钱包无法说明原因。您的资金没有转移。" +
        "请重试——如果一直如此，很可能是链数据源故障，而不是您的钱包。",
    },
  },
} as const;
