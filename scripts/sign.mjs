// Code signing for ctrl.app (packaged and dev). macOS ties privacy grants (Documents, Desktop, …)
// to the app's designated requirement. Ad hoc, that's the binary's hash, so every build asks again.
// Signed with the "ctrl Code Signing" certificate it's "this bundle id + this certificate", which
// survives rebuilds and updates on every Mac. See docs/DEVELOPMENT.md → Signing.
import { execFileSync } from "node:child_process"

export const IDENTITY = process.env.CTRL_SIGN_IDENTITY || "ctrl Code Signing"

/** The certificate is self-signed, so it's listed as untrusted; codesign uses it all the same. */
export function hasIdentity() {
  try {
    return execFileSync("security", ["find-identity", "-p", "codesigning"], { encoding: "utf8" }).includes(
      `"${IDENTITY}"`,
    )
  } catch {
    return false
  }
}

/** Signs with the certificate when this Mac has it, ad hoc otherwise. Returns what it used. */
export function sign(app, { requireIdentity = false, stdio = "inherit" } = {}) {
  const identity = hasIdentity() ? IDENTITY : null
  if (!identity && requireIdentity) {
    throw new Error(`No "${IDENTITY}" certificate in the keychain (docs/DEVELOPMENT.md → Signing)`)
  }
  execFileSync("codesign", ["--force", "--deep", "--sign", identity ?? "-", app], { stdio })
  return identity ?? "ad hoc"
}
