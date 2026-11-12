/**
 * Outbound-URL guard (Wallet#9).
 *
 * This repo is public, and the URLs it ships are a phishing surface: the
 * Midnight redemption portal, the wallet install link, the curated dApp
 * allow-list, the indexer base URLs. A homoglyph swap — `redeem.midnlght.gd`
 * for `redeem.midnight.gd` — is a one-character diff that no reviewer catches
 * by accident, and the wallet's own brand would vouch for the fake.
 *
 * CODEOWNERS makes changes to those files require a maintainer review. But that
 * only helps for files somebody remembered to list. This check closes the other
 * half: an absolute URL may appear ONLY in a file CODEOWNERS already gates.
 *
 * The allow-list is READ FROM CODEOWNERS rather than repeated here, so the two
 * cannot drift apart. Since CODEOWNERS gained its catch-all `*` line, every file
 * already needs an owner's review; what this guard adds is that a URL may only
 * sit in a file a CODEOWNERS line NAMES (its own path, or a directory above it),
 * so the places that can carry a destination stay a short, listed set.
 *
 * What this guard does not stop, stated so nobody mistakes it for more than it
 * is: a URL its author is deliberately hiding. Hex fed to `Buffer.from(…, "hex")`,
 * `String.fromCharCode(…)`, `decodeURIComponent` of a percent-encoded string, a
 * scheme cut after its first two letters, a host computed from data — all of
 * these build a working URL that no textual check can read. This catches the
 * accident and the lazy shortcut. The author who is hiding is what code review
 * is for.
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * The repo this script lives in, unless a root is passed as the first argument.
 * The argument exists for the tests: they stage a small tree containing exactly
 * the input a rule must refuse, which is the only way to show the rule refuses
 * it — writing that input into this repo would fail this very check.
 */
const REPO = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Directories that ship code. `src` was the only one when this guard was
 * written, and that was the flaw: the extension arrived later as a NEW
 * top-level directory whose `manifest.json` holds the `host_permissions` list —
 * the single setting that decides which hosts the wallet may talk to — and the
 * guard walked straight past it. Measured: swapping a Koios host for a
 * look-alike in `extension/manifest.json` and adding an unrelated host left this
 * check reporting OK.
 *
 * `assertNoUnscannedSourceRoot()` below is what stops that happening again. A
 * hand-maintained list drifts; a list that fails CI when it falls behind does not.
 */
const SCAN_ROOTS = ["src", "extension", "scripts", "docs"];

/** Never source, or gated wholesale elsewhere. */
const NOT_SOURCE = new Set([".git", "node_modules", "dist-extension", ".claude", "_Agents", "locales", ".github"]);

/** Build output living inside a source root. Not written by hand, not shipped. */
const BUILD_OUTPUT = new Set(["extension/smoke/out"]);

/**
 * Which files are read — ONE rule, used by every step that picks files.
 *
 * There were two: the step that looks for unscanned directories, and the
 * choice of files at the repo root, read only `.js/.ts/.json/.html/.md`, while
 * the walk under the scan roots read everything. Measured: a new `public/`
 * holding only an `.svg` with a link and a `.webmanifest` printed OK (the same
 * directory with a `.json` failed), and so did `bunfig.toml` or `.npmrc` at
 * the root pointing the package registry somewhere else — while the OK line
 * said "every absolute URL at the repo root". A URL reaches the network from
 * an SVG, a manifest or a registry setting as well as from code.
 *
 * Every regular file is read, whatever its name. The one exception is a file
 * with a NUL byte in its first 8 KiB — an image, a font — which no pattern
 * here can read; those are counted and named in every result.
 *
 * That exception is not open to a file whose name says it is text. A NUL in a
 * comment of a `.ts` file, or an HTML page saved as UTF-16, made the whole file
 * "binary" and skipped — CI stayed green while esbuild compiled the first and a
 * browser rendered the second, URL and all. A file with a text extension that
 * has a NUL byte in its first 8 KiB, or starts with a UTF-16 byte order mark,
 * is now a failure: this guard cannot read it, and says so instead of passing.
 */
const binarySkipped = [];
const unreadableText = [];
const TEXT_EXT =
  /\.(?:[mc]?[jt]sx?|json|jsonc|json5|webmanifest|md|markdown|mdx|html?|xhtml|svg|xml|css|scss|less|ya?ml|toml|txt|ini|npmrc)$/i;
/** "text", "binary" (skipped and named), or why a text file cannot be read. */
function classify(full) {
  const fd = openSync(full, "r");
  let head;
  try {
    const buf = Buffer.alloc(8192);
    head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
  } finally {
    closeSync(fd);
  }
  const utf16 = head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));
  const nul = head.includes(0);
  if (TEXT_EXT.test(full) && (utf16 || nul)) return utf16 ? "is UTF-16" : "has a NUL byte in its first 8 KiB";
  return nul ? "binary" : "text";
}
/** Sorts one regular file into read, skipped, or refused; true when it is read. */
function readable(full, rel) {
  if (!statSync(full).isFile()) return false;
  const kind = classify(full);
  if (kind === "text") return true;
  if (kind === "binary") {
    if (!binarySkipped.includes(rel)) binarySkipped.push(rel);
  } else if (!unreadableText.some((u) => u.startsWith(rel + " "))) unreadableText.push(`${rel} ${kind}`);
  return false;
}
const CODEOWNERS = join(REPO, ".github", "CODEOWNERS");

/**
 * An absolute URL with a plausible registrable host. Deliberately does NOT match
 * UI placeholders like `https://…/drep.jsonld`, whose "host" is an ellipsis —
 * those ship no destination and are not a phishing surface.
 *
 * The slashes are optional, and may be backslashes, because that is what a
 * browser accepts. For the special schemes the WHATWG URL parser treats a
 * missing `//`, a single slash and backslashes alike as the authority marker,
 * so `https:` followed directly by a host is a working absolute URL — and a
 * version of this pattern that insisted on two forward slashes passed it as
 * text. `ws:`/`wss:` are here because a WebSocket reaches the network just as
 * a fetch does.
 *
 * The lookbehind anchors the scheme at the start of a word. Without it the
 * `ws` at the end of `rows` reads as the scheme of `rows:data.length`, and a
 * type annotation in a plain source file failed the gate; `+` and `-` are
 * excluded for the same reason — `foo-https://` is prose, not a URL.
 *
 * After at least one slash, ANY host counts. An earlier version wanted an ASCII
 * label and a dot, and the URL parser wants neither: userinfo
 * (`x@evil.example`), a percent-encoded host, a dotless IPv4 address in decimal
 * or hex, an IPv6 literal in brackets, and a look-alike whose first label is
 * Cyrillic — the very homoglyph this guard exists for — each parse as an
 * absolute URL, and each printed OK. A backslash that starts a JavaScript
 * escape (`\n`, `\t`, `\x…`, `\u…`) is not read as a slash: those are
 * decoded and read again by `hiddenInEscapes`.
 *
 * With no slash at all, `ws:x` is an object key, not a URL, so the host must
 * then show a sign of being one — a dot, `@`, `%`, `[`, or a leading digit.
 *
 * A `*` is a host character. It used to be excluded, so a match pattern with a
 * real host in it — `https://*.evil.example/*`, or `*://evil.example/*` with a
 * wildcard scheme — read as carrying no destination and printed OK, although
 * it names exactly the hosts it reaches. What is left alone is the one pattern
 * that names no host: a host that is `*` and nothing else (`https://*`,
 * `https://*\/…`, `*://*\/…`).
 */
const HOST_CHAR = "[^\\s\"'`<>\\\\/…$(){},;|^]";
const SLASHES = "(?:/|\\\\(?![nrtvbfux0-9]))+";
const NOT_BARE_STAR = "(?!\\*(?:[/\\s\"'`<>),;\\]]|$))";
const URL_RE = new RegExp(
  "(?<![a-z0-9+.-])(?:(?:https?|wss?):" +
    `(?:${SLASHES}${NOT_BARE_STAR}${HOST_CHAR}+|[0-9]${HOST_CHAR}*|${HOST_CHAR}*[.@%[]${HOST_CHAR}*)` +
    `|\\*:${SLASHES}${NOT_BARE_STAR}${HOST_CHAR}+)`,
  "gi",
);

/**
 * A host with no scheme, at the very start of a decoded string. Used only on
 * text recovered from base64, where there is no surrounding quote to anchor on.
 */
const PROTOCOL_RELATIVE_START = new RegExp(
  "^\\s*[\\/\\\\]{2}(?:[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)+|[0-9]+(?:[/:?#]|$)|[^\\s/@]+@[^\\s/]+|\\[[0-9a-f:.]+\\]|%[0-9a-f]{2})",
  "i",
);

/**
 * A protocol-relative URL — two slashes, then a host — inside a string literal
 * (a backquoted one in a comment reads the same, so this file spells it out
 * in words). The host is
 * anything URL_RE accepts as one, except the bare `*` of a match pattern.
 */
const PROTOCOL_RELATIVE_QUOTED = new RegExp(`["'\`](?:\\\\?/|\\\\\\\\){2}${NOT_BARE_STAR}${HOST_CHAR}`);

/**
 * The same with no quote, where markup takes one: a Markdown link target
 * (`[x](//host)`) or reference definition (`[x]: //host`), an unquoted HTML
 * attribute (`href=//host`), and a CSS `url(//host)`. Only read in markup and
 * style files, where neither `(//` nor `=//` is a code comment.
 */
const PROTOCOL_RELATIVE_MARKUP = new RegExp(
  `(?:[(=]|^[ \\t]*\\[[^\\]\\n]+\\]:)[ \\t]*<?[/\\\\]{2}${NOT_BARE_STAR}${HOST_CHAR}`,
  "im",
);
const MARKUP_EXT = /\.(?:md|markdown|mdx|html?|xhtml|svg|xml|css|scss|less)$/i;

/**
 * A URL whose host is not in the file — assembled at runtime instead.
 *
 * The check above only sees hosts written down. Measured against this guard on
 * 2026-09-08, two mutations were added to a source file and it still printed OK:
 * a scheme string concatenated with a host string, and a scheme in a template
 * literal with the host interpolated from a nearby constant. (Both are spelled
 * out in the tests rather than here, because writing either one in this file
 * would trip the rule it documents.)
 *
 * That is the whole guard defeated by a spacebar, and a gate that reports OK for
 * exactly what it exists to block is worse than no gate: the commit message
 * cites it as the constraint in force. Nothing in this repo has a reason to
 * build a scheme by concatenation, so both forms are refused outright — in
 * every scanned file, gated or not, because the point is that the host be
 * *visible* to the other checks, not merely reviewed.
 *
 * `https://…` (ellipsis) and `https://*` (a manifest match pattern) carry no
 * destination and are left alone.
 */
const ASSEMBLED = [
  // A string literal ending in a scheme separator, handed straight to `+` or
  // `.concat` — on the same line, or on the next one where a formatter wrapped
  // it. Anchoring on the separator rather than on the word "https" also catches
  // a scheme torn in half across two literals, which otherwise reads as two
  // harmless fragments. The joiner must be an operator: a comma after a scheme
  // is ordinary prose and ordinary arguments, and matching it flags both.
  [
    /:\/\/["'`][ \t]*(?:\r?\n[ \t]*)?(?:\+|\.concat\b)/,
    "a scheme string joined to something else",
  ],
  // The array form of the same thing: a scheme string as the first element,
  // on its way to `.join`. Requiring the opening bracket is what separates it
  // from a comma in a sentence. The separator inside the element is optional
  // — a scheme-colon element with a host element after the comma builds the
  // URL without it — but then the second element must look like a host (a dot
  // in it), because a list of bare protocol strings (`["http:", "file:"]`,
  // in the keystore tests) is an ordinary argument list, not a URL being
  // assembled.
  [
    /\[[ \t]*["'`][^"'`\n]*(?::\/\/|(?:https?|wss?):(?:\\?\/){0,2})["'`][ \t]*,[ \t]*["'`][^"'`\n]*[a-z0-9]\.[a-z0-9][^"'`\n]*["'`]/i,
    "a scheme string as an array element",
  ],
  // A template literal starting with a scheme, interpolating anywhere in the
  // host — putting the placeholder after a subdomain hides the registrable part
  // just as well as putting it first. The slashes after the colon are optional
  // for the same reason they are in URL_RE: a scheme, a colon and an
  // interpolated host parses with none of them.
  // The scheme may be absent: a template starting with the two slashes is a
  // protocol-relative URL whose host is filled in at runtime.
  [
    /`(?:(?:https?|wss?):[\/\\]*|(?:\\?\/|\\\\){2})[^`\n]*\$\{/i,
    "a host interpolated into a template literal",
  ],
  // The scheme without its separator, glued to it afterwards. `+` and
  // `.concat` both glue; a comma still does not, because a bare protocol
  // literal is an ordinary argument — this repo passes several to a test
  // helper — and matching commas would flag every one. Case-insensitive
  // because an upper-case scheme glued to a host builds the same URL.
  [
    /["'`](?:https?|wss?):["'`][ \t]*(?:\+|\.concat\b)/i,
    "a scheme split across string literals",
  ],
  // A piece of the scheme itself, as a whole literal, about to be glued to
  // the rest of it: a scheme cut after its third or fourth letter, with the
  // remainder and its separator in the next literal, spells a URL none of the
  // rules above can see — no literal contains a scheme, and the separator
  // rules below need the separator to touch other text. Pieces at least three
  // letters long (`htt` and up on the http side, `ws` and `wss` on the
  // WebSocket side) are refused; shorter ones — the first letter or two of a
  // scheme alone — are indistinguishable from building an ordinary word out of
  // pieces, and are left to review.
  [
    /["'`](?:https?|wss?|htt)["'`][ \t]*(?:\+|\.concat\b)/i,
    "a scheme fragment split across string literals",
  ],
  // The separator on its own, as a whole literal. Every form above anchors on a
  // scheme or a separator touching some other text; an array of scheme and host
  // handed to `.join` with the separator as its argument touches neither, and
  // passed. Nothing in this repo has a use for a string that is only the
  // separator (or only its two slashes), so the literal itself is refused.
  // A backquoted one counts only where an expression can start — after `=`,
  // `(`, `,` or `[` — because prose in comments quotes the comment marker in
  // backquotes all the time, and that is not code. A quoted one counts only
  // outside the string methods that take a separator as an argument — the
  // ones named in the lookbehind take a string apart on its two slashes —
  // while `join`, which is how a URL is assembled from one, is deliberately
  // not among them.
  [
    /(?<!\.(?:split|replace|replaceAll|includes|startsWith|endsWith|indexOf|lastIndexOf|match|matchAll|search|test|exec|at|slice|substring|substr)\(\s*)["']:?(?:\\?\/){2}["']|(?:^|[=(,[])[ \t]*`:?(?:\\?\/){2}`/,
    "a scheme separator as a string of its own",
  ],
  // A literal starting with the two slashes, appended after a `+`: a protocol
  // read from somewhere (or a lone colon), then the start of a host, with the
  // rest of the host in a further piece. No piece is a URL on its own, and a
  // host torn before its dot is not protocol-relative to the rule below either.
  [/\+[ \t]*(?:\r?\n[ \t]*)?["'`](?:\\?\/){2}[^\s"'`]/, "a scheme separator appended to something else"],
  // Protocol-relative. Two slashes and a host inherit https on a page served over https, so
  // it reaches the network exactly like an absolute URL while containing no
  // scheme for anything above to find. A path after the host is not needed for
  // that, so none is required here; backslashes and escaped slashes are the
  // same two characters to the URL parser and to the JS lexer respectively.
  // Any host counts, with the same host characters as URL_RE: this rule used
  // to want an ASCII label and a dot, and a dotless decimal IPv4 address,
  // userinfo, an IPv6 literal and a percent-encoded host each passed it while
  // `new URL()` resolved them against the page to an https URL.
  [PROTOCOL_RELATIVE_QUOTED, "a protocol-relative URL"],
  // Slashes spelled as escape sequences.
  [/(?:https?|wss?):(?:\\u002f|\\x2f){2}/i, "a scheme whose slashes are escape sequences"],
];

/**
 * A URL hidden in base64 — `atob` of a literal, `Buffer.from(…, "base64")`, or a
 * constant decoded somewhere else. The host is in the file, but in a form no
 * reviewer reads and no pattern above matches.
 *
 * Every string literal made only of base64 (or base64url) characters is decoded
 * and checked for a URL. This looks at the literal rather than at the call that
 * decodes it, so moving the literal into a constant does not move it out of
 * sight. It does not look INSIDE a longer literal: a `data:` URI carries base64
 * that legitimately decodes to markup with an XML namespace URL in it, and that
 * namespace is an identifier, not a request.
 */
const BASE64_LITERAL = /(["'`])([A-Za-z0-9+/_-]{8,}={0,2})\1/g;
const URL_ONCE = new RegExp(URL_RE.source, "i");

function hiddenInBase64(line) {
  for (const m of line.matchAll(BASE64_LITERAL)) {
    const decoded = Buffer.from(m[2].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    if (URL_ONCE.test(decoded) || PROTOCOL_RELATIVE_START.test(decoded)) return true;
  }
  return false;
}

/**
 * A URL hidden behind escape sequences. `h\x74tps://…` is `https://…` to the
 * JS lexer and to a browser; to every pattern above it is an `h`, then a `\`,
 * then `x74`, and the scheme is gone. The colon hides just as well:
 * `https\u003a//…`. Measured against this guard, in an ungated file: both
 * printed OK.
 *
 * The window is decoded and read again, but only when reading it as written
 * finds nothing — a URL that is already visible on the line is the URL_RE's
 * business, and a gated file may keep it.
 */
/*
 * `\u{…}` is the same escape with braces, and printed OK until it was read.
 * `\t`, `\n` and `\r` decode to the three characters the URL parser deletes
 * from its input before parsing, wherever they sit — so `h` + tab + `ttps:…` is
 * `https:…` to `new URL()`. They decode to nothing here, and a literal tab in
 * the source is deleted for the same reason.
 */
/*
 * A real line break hides a URL the same way, and so does a backslash before
 * one. The window is two lines, and a JSX attribute may hold a newline
 * (`href="https:/` ⏎ `/evil.example/p"` — esbuild keeps it, `new URL()` deletes
 * it), and a backslash at the end of a line inside a JS string is a line
 * continuation the lexer deletes with the break. Both printed OK. A real CR or
 * LF now decodes to nothing, a continuation first.
 *
 * In a style sheet the escape is CSS's own: a backslash, one to six hex digits
 * and an optional whitespace character (`https\3a //…` is `https://…`, and
 * esbuild's minifier writes it out as the plain URL), or a backslash before
 * any other character, which stands for that character. Measured: printed OK.
 * A `.css`/`.scss`/`.less` file is read both ways — as CSS, and as before.
 */
const ESCAPE_HERE = /\\(?:[xu][0-9a-f{]|[tnr]|\r|\n|\u2028|\u2029)|\t/i;
const ESCAPE_SEQ = /\\x([0-9a-f]{2})|\\u([0-9a-f]{4})|\\u\{([0-9a-f]{1,6})\}|\\[tnr]|\t/gi;
const CONTINUATION = /\\(?:\r\n?|\n|\u2028|\u2029)/g;
const CSS_ESCAPE = /\\([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\r\n\f0-9a-f])/gi;
const CSS_EXT = /\.(?:css|scss|less)$/i;
const codePoint = (hex) => {
  const n = parseInt(hex, 16);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
};
function decodeEscapes(text) {
  return text
    .replace(CONTINUATION, "")
    .replace(ESCAPE_SEQ, (_, x, u, cp) => {
      const hex = x ?? u ?? cp;
      if (hex === undefined) return "";
      const n = parseInt(hex, 16);
      return n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/[\r\n]/g, "");
}
function decodeCssEscapes(text) {
  return text
    .replace(CONTINUATION, "")
    .replace(CSS_ESCAPE, (_, hex, ch) => (hex === undefined ? ch : codePoint(hex)))
    .replace(/[\t\r\n]/g, "");
}
/*
 * Every window holds a line break, so every window is decoded. A host at the
 * very start of the decoded text (PROTOCOL_RELATIVE_START) is read only when
 * the window holds a real escape: otherwise a line comment whose first word is
 * a dotted name (two slashes, then `console.log(x)`) would read as a host. A quoted protocol-relative URL that
 * only the decoding produced (`href="/` ⏎ `/evil.example"`) is read always.
 */
function hiddenInEscapes(text, css) {
  if (URL_ONCE.test(text)) return false;
  const escaped = ESCAPE_HERE.test(text) || (css && text.includes("\\"));
  const quoted = PROTOCOL_RELATIVE_QUOTED.test(text);
  const decoded = css ? [decodeEscapes(text), decodeCssEscapes(text)] : [decodeEscapes(text)];
  return decoded.some(
    (d) =>
      URL_ONCE.test(d) ||
      (!quoted && PROTOCOL_RELATIVE_QUOTED.test(d)) ||
      (escaped && PROTOCOL_RELATIVE_START.test(d)),
  );
}

/**
 * A URL hidden behind HTML character references. `https&#58;//…` in an HTML
 * attribute, a Markdown link or a JSX attribute string is `https://…` to the
 * browser and to esbuild (measured: a `.tsx` `href` came out of the build as
 * the plain URL), and to the patterns here it is an `https`, an ampersand and
 * no scheme. The references are decoded and the window read again — after the
 * URLs already visible on it are blanked, so `&amp;` in a visible URL's query
 * neither hides a second URL nor counts as one.
 *
 * Numeric references are read with or without their `;` (HTML accepts both);
 * named ones only for the characters a URL is built from. Tab and newline
 * decode to nothing, as the URL parser drops them.
 */
const ENTITY_HERE = /&(?:#[0-9]|#x[0-9a-f]|[a-z]+;)/i;
const NAMED = {
  colon: ":", sol: "/", bsol: "\\", period: ".", commat: "@", percnt: "%", lsqb: "[", lbrack: "[",
  rsqb: "]", rbrack: "]", num: "#", quest: "?", equals: "=", amp: "&", quot: '"', apos: "'", lpar: "(",
  rpar: ")", lowbar: "_", tab: "", newline: "",
};
function decodeEntities(text) {
  return text.replace(/&#x([0-9a-f]{1,6});?|&#([0-9]{1,7});?|&([a-z]+);/gi, (m, hex, dec, name) => {
    if (name !== undefined) return NAMED[name.toLowerCase()] ?? m;
    const n = parseInt(hex ?? dec, hex ? 16 : 10);
    if (n === 9 || n === 10 || n === 13) return "";
    return n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}
/*
 * Script files too, not only JSX: a `.ts` that assigns `innerHTML` or builds
 * markup in a string hands the references to the HTML parser, which decodes
 * them. A colon spelled `&#58;` inside a `.ts` string printed OK.
 */
const ENTITY_EXT = /\.(?:md|markdown|mdx|html?|xhtml|svg|xml|[mc]?[jt]sx?)$/i;
function hiddenInEntities(window, markup) {
  if (!ENTITY_HERE.test(window)) return false;
  const decoded = decodeEntities(window.replace(new RegExp(URL_RE.source, "gi"), " "));
  return (
    URL_ONCE.test(decoded) ||
    PROTOCOL_RELATIVE_QUOTED.test(decoded) ||
    (markup && PROTOCOL_RELATIVE_MARKUP.test(decoded)) ||
    PROTOCOL_RELATIVE_START.test(decoded)
  );
}

/**
 * A URL hidden in base64 torn across literals. One literal decodes to
 * `https:/`, the other to `evil.com`, and `atob("…" + "…")` decodes the pair
 * to a URL; measured against this guard, both halves printed OK, because
 * neither half is a URL on its own.
 *
 * Only runs that actually decode to a URL are refused: two base64-looking
 * literals joined by `+` are ordinary string-building most of the time, and
 * text that does not decode to a URL is none of this gate's business.
 */
const JOINED_B64 = new RegExp(
  `${BASE64_LITERAL.source}(?:[ \\t]*(?:\\r?\\n[ \\t]*)?\\+[ \\t]*(?:\\r?\\n[ \\t]*)?${BASE64_LITERAL.source})+`,
  "g",
);
function hiddenInJoinedBase64(text) {
  for (const m of text.matchAll(JOINED_B64)) {
    const parts = [...m[0].matchAll(BASE64_LITERAL)].map((p) => p[2].replace(/-/g, "+").replace(/_/g, "/"));
    const decoded = Buffer.from(parts.join(""), "base64").toString("latin1");
    if (URL_ONCE.test(decoded) || PROTOCOL_RELATIVE_START.test(decoded)) return true;
  }
  return false;
}

const OWNER = /^(?:@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?|[^@\s]+@[^@\s]+\.[^@\s]+)$/;

/**
 * A CODEOWNERS pattern as GitHub matches it (gitignore syntax, with GitHub's
 * documented differences): a leading or inner `/` anchors it at the root, and
 * without one it matches at any depth; a trailing `/` means "everything under
 * this directory"; a name with no wildcard also covers everything under it;
 * `*` and `?` stay inside a segment and `**` crosses segments; and a last
 * segment with a wildcard (`docs/*`, `extension/*.html`) matches files at that
 * level only, not below.
 */
function codeownersRegExp(pattern) {
  const anchored = pattern.startsWith("/") || pattern.replace(/\/$/, "").includes("/");
  const dirOnly = pattern.endsWith("/");
  const body = pattern.replace(/^\//, "").replace(/\/$/, "");
  let re = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "*" && body[i + 1] === "*") {
      i += 1;
      if (body[i + 1] === "/") {
        i += 1;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  const lastSeg = body.split("/").pop() ?? "";
  const tail = dirOnly ? "/.*" : /[*?]/.test(lastSeg) ? "" : "(?:/.*)?";
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}${tail}$`);
}

/**
 * Every CODEOWNERS line GitHub reads, in order, with whether it assigns an
 * owner. Order matters: GitHub applies the LAST line that matches a file.
 */
function gatedPaths() {
  const rules = [];
  for (const raw of readFileSync(CODEOWNERS, "utf8").split("\n")) {
    // A `#` starts a comment wherever it sits — GitHub's own example has one
    // after the owners, and escaping it with `\` is documented as not working.
    // Reading the line whole counted `/src/b.ts  # owned by @someone later` as
    // owned, because one of its words contained an `@`.
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) continue;
    // GitHub skips a line with invalid syntax, so a line is counted only when
    // every owner on it has a form GitHub accepts: `@user`, `@org/team`, or an
    // email address.
    if (!owners.every((o) => OWNER.test(o))) continue;
    // A pattern with no owner after it is kept, as a line that REMOVES
    // ownership: GitHub applies the last matching line, and an ownerless one
    // overrides everything above it, the `*` floor and a directory line alike.
    rules.push({ pattern, path: pattern.replace(/^\//, ""), owned: owners.length > 0, re: codeownersRegExp(pattern) });
  }
  return rules;
}

/**
 * Two conditions, both required.
 *
 * The file has an owner: the last CODEOWNERS line matching it assigns one.
 * Counting any owned line that names the file was wrong in one direction —
 * `/extension/*.html` with no owner, after `/extension/ @owner`, leaves
 * `extension/x.html` with no owner on GitHub, and this guard still counted it
 * as gated.
 *
 * And an owned line NAMES it, as a literal path or a directory prefix — never
 * by a wildcard. That is what keeps CODEOWNERS' catch-all `*` line, a review
 * floor for every file, from also reading as "every file may carry a URL".
 */
function isGated(relPath, rules) {
  const last = rules.filter((r) => r.re.test(relPath)).pop();
  if (!last || !last.owned) return false;
  return rules.some(
    (r) => r.owned && (r.path.endsWith("/") ? relPath.startsWith(r.path) : relPath === r.path),
  );
}

function* walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = relative(REPO, full).split(sep).join("/");
    if (BUILD_OUTPUT.has(rel) || entry === "node_modules") continue;
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (readable(full, rel)) yield full;
  }
}

/**
 * Fail when a top-level directory holds source we never look at. This is the
 * part that survives the next person adding a directory.
 */
function assertNoUnscannedSourceRoot() {
  const missed = [];
  for (const entry of readdirSync(REPO).sort()) {
    if (NOT_SOURCE.has(entry) || SCAN_ROOTS.includes(entry)) continue;
    const full = join(REPO, entry);
    if (!statSync(full).isDirectory()) continue;
    for (const _ of walk(full)) {
      missed.push(entry);
      break;
    }
  }
  if (missed.length) {
    console.error("Outbound-URL guard FAILED — source directories nobody scans:\n");
    for (const d of missed) console.error(`  • ${d}/`);
    console.error("\nAdd them to SCAN_ROOTS in this file, or to NOT_SOURCE if they ship nothing.");
    process.exit(1);
  }
}

assertNoUnscannedSourceRoot();

const rules = gatedPaths();
const offenders = [];

// Files sitting at the repo root are scanned by rule, not by a list: README.md is
// the most-read file in a public repo and carried the install link nobody gated.
const rootFiles = readdirSync(REPO)
  .sort()
  .map((entry) => join(REPO, entry))
  .filter((full) => !statSync(full).isDirectory() && readable(full, relative(REPO, full).split(sep).join("/")));

const assembled = [];

for (const file of [...rootFiles, ...SCAN_ROOTS.flatMap((root) => [...walk(join(REPO, root))])]) {
  const rel = relative(REPO, file).split(sep).join("/");
  const text = readFileSync(file, "utf8");

  // Two lines at a time, overlapping, rather than the whole file: enough to see
  // a concatenation that wrapped onto the next line, while still naming the line
  // the offending text is on. Whole-file matching finds the same things and can
  // only report "somewhere in this file".
  const lines = text.split("\n");
  const markup = MARKUP_EXT.test(rel);
  const entities = ENTITY_EXT.test(rel);
  const css = CSS_EXT.test(rel);
  for (let i = 0; i < lines.length; i += 1) {
    const window = lines[i] + "\n" + (lines[i + 1] ?? "");
    let hit = null;
    for (const [re, why] of ASSEMBLED) {
      if (re.test(window)) {
        hit = why;
        break;
      }
    }
    if (!hit && markup && PROTOCOL_RELATIVE_MARKUP.test(window)) hit = "a protocol-relative URL";
    if (!hit && entities && hiddenInEntities(window, markup)) hit = "a URL written with HTML character references";
    if (!hit && hiddenInBase64(lines[i])) hit = "a URL encoded in base64";
    if (!hit && hiddenInEscapes(window, css)) hit = "a URL written with escape sequences";
    if (!hit && hiddenInJoinedBase64(window)) hit = "a URL encoded in base64";
    if (hit) assembled.push(`${rel}:${i + 1}  ${hit}\n      ${lines[i].trim()}`);
  }

  const found = new Set(text.match(URL_RE) ?? []);
  if (found.size === 0) continue;
  if (isGated(rel, rules)) continue;
  offenders.push({ rel, urls: [...found] });
}

const skippedNote = `${binarySkipped.length} binary file${binarySkipped.length === 1 ? "" : "s"} not read${binarySkipped.length ? ": " + binarySkipped.join(", ") : ""}`;

if (unreadableText.length) {
  console.error(`(${skippedNote}.)\n`);
  console.error("Outbound-URL guard FAILED — text files this guard cannot read:\n");
  for (const u of unreadableText) console.error(`  • ${u}`);
  console.error("\nSave them as UTF-8 without NUL bytes; a file named as text is read as text.");
  process.exit(1);
}

if (assembled.length) {
  console.error(`(${skippedNote}.)\n`);
  console.error("Outbound-URL guard FAILED — URLs built at runtime, so no check can read the host:\n");
  for (const line of assembled) console.error(`  • ${line}`);
  console.error("\nWrite the full URL as one literal in a CODEOWNERS-gated file.");
  process.exit(1);
}

if (offenders.length) {
  console.error(`(${skippedNote}.)\n`);
  console.error("Outbound-URL guard FAILED — absolute URLs in ungated files:\n");
  for (const { rel, urls } of offenders) {
    console.error(`  • ${rel}`);
    for (const u of urls) console.error(`      ${u}`);
  }
  console.error(
    "\nEither drop the URL, or name the file in .github/CODEOWNERS — its own path or" +
      "\na directory above it, with an owner; the catch-all `*` line does not count." +
      "\nThose lines are the list of files allowed to carry a URL, and adding one is" +
      "\nitself a change an owner has to approve.",
  );
  process.exit(1);
}

console.log(
  `Outbound-URL guard OK — every absolute URL in a text file at the repo root and under ${SCAN_ROOTS.map((r) => r + "/").join(", ")} sits in a CODEOWNERS-gated file, and none is assembled at runtime (${skippedNote}).`,
);
