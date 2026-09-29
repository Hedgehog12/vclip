/**
 * Two stat results describe the same file. On Windows, stat by path reports
 * device 0 while stat on an open handle reports the volume serial number, so
 * a zero device there matches on the file index alone.
 */
export function sameFile(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  if (a.ino !== b.ino) return false
  return a.dev === b.dev || (process.platform === 'win32' && (a.dev === 0 || b.dev === 0))
}
