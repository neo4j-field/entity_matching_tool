// Generates the application icon from code, so it can be adjusted and rebuilt
// rather than being an opaque binary. No dependencies: Node's zlib is enough to
// write a PNG, and macOS `sips`/`iconutil` handle the .icns.
//
//   node scripts/make-icon.mjs
//
// The mark is two overlapping discs with the intersection lit — two records
// that turn out to be one entity, which is what the tool does.

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 1024

const BG = [15, 23, 42]        // slate-900, legible on light and dark docks
const LEFT = [5, 150, 105]     // emerald-600
const RIGHT = [110, 231, 183]  // emerald-300 — distinct enough to read as two
const LENS = [240, 253, 250]   // near-white — the resolved identity

// Analytic coverage: 1px of smoothing at the edge, which is enough at this size
// and avoids supersampling a 4096px buffer.
const cov = (d) => Math.min(1, Math.max(0, 0.5 - d))

function roundedRect(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(x - cx) - (halfW - r)
  const dy = Math.abs(y - cy) - (halfH - r)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - r
}

function render(size) {
  const k = size / 1024
  const px = Buffer.alloc(size * size * 4)
  const R = 288 * k
  const CY = size / 2
  const LX = size / 2 - 122 * k
  const RX = size / 2 + 122 * k
  // Edge softening is one output pixel at every size, so a 16px icon gets the
  // same relative crispness as a 1024px one. Drawing each size natively rather
  // than downscaling keeps the small ones from going muddy.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x + 0.5, sy = y + 0.5
      let r = 0, g = 0, b = 0, a = 0
      const over = (col, c) => {
        if (c <= 0) return
        const na = c + a * (1 - c)
        r = (col[0] * c + r * a * (1 - c)) / na
        g = (col[1] * c + g * a * (1 - c)) / na
        b = (col[2] * c + b * a * (1 - c)) / na
        a = na
      }
      over(BG, cov(roundedRect(sx, sy, size / 2, size / 2, 448 * k, 448 * k, 200 * k)))
      const dl = Math.hypot(sx - LX, sy - CY) - R
      const dr = Math.hypot(sx - RX, sy - CY) - R
      over(LEFT, cov(dl))
      over(RIGHT, cov(dr))
      over(LENS, Math.min(cov(dl), cov(dr)))

      const i = (y * size + x) * 4
      px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b)
      px[i + 3] = Math.round(a * 255)
    }
  }
  return px
}

function png(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, cr])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const pngAt = (size) => png(size, size, render(size))

mkdirSync(join(ROOT, 'build'), { recursive: true })
const master = pngAt(SIZE)
writeFileSync(join(ROOT, 'build', 'icon.png'), master)
writeFileSync(join(ROOT, 'resources', 'icon.png'), master)

// Windows .ico: a container of PNGs, which every supported Windows version
// reads. A width byte of 0 means 256.
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const images = icoSizes.map((n) => ({ n, data: pngAt(n) }))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4)
let offset = 6 + images.length * 16
const entries = images.map(({ n, data }) => {
  const e = Buffer.alloc(16)
  e[0] = n === 256 ? 0 : n; e[1] = n === 256 ? 0 : n
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6)
  e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12)
  offset += data.length
  return e
})
writeFileSync(join(ROOT, 'build', 'icon.ico'), Buffer.concat([header, ...entries, ...images.map((i) => i.data)]))

// macOS .icns, via the iconset layout iconutil expects. Skipped off macOS.
const iconset = join(ROOT, 'build', 'icon.iconset')
mkdirSync(iconset, { recursive: true })
for (const [name, n] of [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
]) writeFileSync(join(iconset, name), pngAt(n))

try {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(ROOT, 'build', 'icon.icns')])
  rmSync(iconset, { recursive: true, force: true })
  console.log('wrote build/icon.png, resources/icon.png, build/icon.ico, build/icon.icns')
} catch {
  console.log('wrote build/icon.png, resources/icon.png, build/icon.ico; iconutil unavailable, left build/icon.iconset for a macOS run')
}
