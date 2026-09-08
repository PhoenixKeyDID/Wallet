import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Argon2id is slow on purpose — that is the entire point of a password KDF.
    // The vault tests run it twice at the shipping parameters (m=19456 KiB,
    // t=2). Measured: `vault > changes the password without changing the
    // wallet` takes ~1.4s on a warm machine and timed out at vitest's 5s
    // default on a cold one (transform cache cleared). A CI runner is always
    // the cold case, so the default turns a correct test into an occasionally
    // red build — and an occasionally red build is one people stop reading.
    // This weakens nothing: a KDF that took 30s would still fail here.
    testTimeout: 30_000,

    // The cardano core is pure TypeScript — no DOM needed.
    environment: "node",
    // `extension/` is included because the rules deciding which websites this
    // wallet answers live there, in `rpc/protocol.ts`. Leaving them out of the
    // test run would mean the one part of the extension that *can* be tested
    // was the part nothing tested.
    //
    // `?(x)` matters even though no `.tsx` test exists yet: without it, the
    // first component test anyone adds is collected by nobody and reported by
    // nothing, which is worse than a missing test because the repo counts it as
    // coverage. Both halves of this line were arrived at separately and both
    // are kept — the directory and the extension.
    include: ["src/**/*.test.ts?(x)", "extension/**/*.test.ts?(x)"],
  },
});
