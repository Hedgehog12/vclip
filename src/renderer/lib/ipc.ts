import type { VlasiichukClipAPI } from '../../preload/index'

declare global {
  interface Window {
    vlasiichukclip: VlasiichukClipAPI
  }
}

export function getApi(): VlasiichukClipAPI {
  return window.vlasiichukclip
}
