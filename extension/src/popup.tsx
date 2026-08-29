/**
 * The extension popup.
 *
 * Same wallet as the web page, in a stronger container. Two things differ, and
 * both are the reason the extension exists at all:
 *
 * - **Its own origin.** The popup runs in the extension's context, which no
 *   web page can script into. On the web page, an XSS anywhere on the site is
 *   an XSS in the wallet; here it is not.
 * - **A strict CSP with no remote code.** `script-src 'self'` in the manifest
 *   means nothing loads from a CDN, ever — the only code that can run is code
 *   that shipped in the reviewed package.
 *
 * The keys live only while this popup is open. Closing it destroys the
 * JavaScript context and the keys with it. That is a real inconvenience — you
 * unlock again next time — and it is kept on purpose: it means the wallet is
 * not sitting unlocked in a background worker for hours while nobody is
 * looking at it.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { i18n } from "./i18n";
import { LocalWalletPanel } from "../../src/components/wallet/LocalWalletPanel";
import "./popup.css";

function App() {
  return (
    <div className="popup">
      <header className="popup-head">
        <span className="popup-mark" aria-hidden>
          🔑
        </span>
        <div>
          <h1>Phoenix Wallet</h1>
          <p>Apache-2.0 · self-custody</p>
        </div>
      </header>
      <main>
        <LocalWalletPanel />
      </main>
      <footer>
        <p>
          Beta, unaudited. Test on preprod before trusting it with real funds.
        </p>
      </footer>
    </div>
  );
}

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </StrictMode>,
  );
}
