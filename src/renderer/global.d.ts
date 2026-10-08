import type { CtrlApi } from "../shared/types"

declare global {
  interface Window {
    ctrl: CtrlApi
  }
}
