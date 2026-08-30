/**
 * Locally-held wallet: create or restore a recovery phrase in the browser,
 * keep it encrypted at rest, and sign with it.
 *
 * This is the fourth mode alongside Connect (CIP-30), Watch-only and Phoenix
 * custody — not a replacement for any of them. It exists so somebody with no
 * extension installed and no DID can still have a wallet, and it carries a
 * risk the other three do not: the signing key lives in the page. The UI must
 * say so plainly, and steer anyone holding real money toward a hardware wallet
 * or an extension.
 */
export {
  createMnemonic,
  normalizeMnemonic,
  mnemonicToEntropyBytes,
  entropyToMnemonicPhrase,
  isWordInList,
  suggestWords,
  MnemonicError,
  type WordCount,
} from "./mnemonic";

export {
  ROLE,
  GAP_LIMIT,
  rootKeyFromEntropy,
  accountKey,
  buildAccount,
  accountFromEntropy,
  primaryAddress,
  allAddresses,
  type Account,
  type DerivedAddress,
} from "./derive";

export {
  VAULT_VERSION,
  DEFAULT_KDF,
  MIN_PASSWORD_LENGTH,
  assertPasswordAcceptable,
  sealVault,
  openVault,
  changeVaultPassword,
  vaultToJson,
  vaultFromJson,
  headerAad,
  toBase64,
  fromBase64,
  VaultError,
  type Vault,
  type VaultKdf,
  type VaultCipher,
} from "./vault";

export {
  witnessesFor,
  signAndSubmitLocal,
  LocalSignError,
  type Submitter,
} from "./signer";
