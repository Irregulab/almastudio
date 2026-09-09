/** Picking and normalising an image for use as a project icon.
 *
 * The chosen file is downscaled to a small square PNG before it is stored, so
 * a 4 MB photograph becomes a few kilobytes of data URL that lives happily
 * inside workspace.json and needs no separate file to keep in sync with the
 * project it belongs to.
 */

import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readFileBase64 } from './ipc'

const ICON_SIZE = 96
/** Refuse anything that plainly is not an icon before decoding it. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

export async function pickProjectIcon(): Promise<string | null> {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: 'Image', extensions: Object.keys(MIME) }],
  })
  if (typeof picked !== 'string') return null
  return loadAsIcon(picked)
}

export async function loadAsIcon(path: string): Promise<string> {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  const mime = MIME[ext] ?? 'image/png'
  const b64 = await readFileBase64(path, MAX_SOURCE_BYTES)
  return downscale(`data:${mime};base64,${b64}`)
}

/** Draws the image into a square canvas, contained and centred. */
function downscale(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = ICON_SIZE
      canvas.height = ICON_SIZE
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        // Without a 2D context there is nothing to shrink it with; the
        // original is still a perfectly good icon, just larger.
        resolve(dataUrl)
        return
      }
      ctx.imageSmoothingQuality = 'high'
      const scale = Math.min(ICON_SIZE / img.width, ICON_SIZE / img.height)
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      ctx.drawImage(img, (ICON_SIZE - w) / 2, (ICON_SIZE - h) / 2, w, h)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('could not decode image'))
    img.src = dataUrl
  })
}
