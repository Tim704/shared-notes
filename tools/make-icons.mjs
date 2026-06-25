// Generate the raster favicon + apple-touch-icon from the same brand mark as
// favicon.svg, using only Node built-ins (zlib) — no native image deps, so it
// is safe to run anywhere. Run with: node tools/make-icons.mjs
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'public')

const ACCENT = [0xff, 0xd2, 0x3f]
const DARK = [0x0e, 0x10, 0x14]
const INK = [0x2a, 0x23, 0x00]
const SS = 4 // supersample for smooth edges

function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false
  const rx = Math.min(r, w / 2)
  const ry = Math.min(r, h / 2)
  let cx = null
  let cy = null
  if (px < x + rx && py < y + ry) {
    cx = x + rx
    cy = y + ry
  } else if (px > x + w - rx && py < y + ry) {
    cx = x + w - rx
    cy = y + ry
  } else if (px < x + rx && py > y + h - ry) {
    cx = x + rx
    cy = y + h - ry
  } else if (px > x + w - rx && py > y + h - ry) {
    cx = x + w - rx
    cy = y + h - ry
  }
  if (cx !== null) {
    const dx = (px - cx) / rx
    const dy = (py - cy) / ry
    return dx * dx + dy * dy <= 1
  }
  return true
}

function renderHi(N) {
  const buf = new Uint8Array(N * N * 4) // transparent
  const u = N / 32 // design is authored on a 32-unit grid
  const set = (x, y, c) => {
    const i = (y * N + x) * 4
    buf[i] = c[0]
    buf[i + 1] = c[1]
    buf[i + 2] = c[2]
    buf[i + 3] = 255
  }
  const fillRR = (x, y, w, h, r, c) => {
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(N, Math.ceil(y + h)); py++) {
      for (let px = Math.max(0, Math.floor(x)); px < Math.min(N, Math.ceil(x + w)); px++) {
        if (inRoundRect(px + 0.5, py + 0.5, x, y, w, h, r)) set(px, py, c)
      }
    }
  }
  fillRR(0, 0, N, N, 7 * u, DARK)
  // rotation is omitted in the raster (keeps it crisp at tiny sizes)
  fillRR(7 * u, 5.5 * u, 18 * u, 21 * u, 3.5 * u, ACCENT)
  fillRR(10 * u, 11 * u, 12 * u, 2 * u, 1 * u, INK)
  fillRR(10 * u, 15.5 * u, 12 * u, 2 * u, 1 * u, INK)
  fillRR(10 * u, 20 * u, 8 * u, 2 * u, 1 * u, INK)
  return buf
}

function downsample(hi, N, size) {
  const out = new Uint8Array(size * size * 4)
  const n = SS * SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * N + (x * SS + dx)) * 4
          r += hi[i]
          g += hi[i + 1]
          b += hi[i + 2]
          a += hi[i + 3]
        }
      }
      const o = (y * size + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// ---- minimal PNG encoder (RGBA, 8-bit) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function encodePNG(rgba, size) {
  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter type: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

function makeIcon(size, file) {
  const N = size * SS
  const hi = renderHi(N)
  const rgba = downsample(hi, N, size)
  fs.writeFileSync(path.join(OUT, file), encodePNG(rgba, size))
  console.log('wrote', file, `(${size}x${size})`)
}

makeIcon(32, 'favicon-32.png')
makeIcon(180, 'apple-touch-icon.png')
