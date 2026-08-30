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
    include: ["src/**/*.test.ts"],
  },
});
