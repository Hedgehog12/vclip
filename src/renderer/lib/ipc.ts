import type { VClipAPI } from '../../preload/index'

declare global {
  interface Window {
    vclip: VClipAPI
  }
}

export function getApi(): VClipAPI {
  return window.vclip
}
