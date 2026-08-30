/**
 * The CSS import in `popup.tsx` is a bundler instruction, not a module the
 * type checker can resolve. Declaring it here keeps `tsc --noEmit` covering the
 * extension instead of the extension being excluded from the type gate.
 */
declare module "*.css";
