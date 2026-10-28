// A tiny store-only ZIP writer (no compression, no dependency), streamed so a
// big pictures folder never has to fit in memory: each file is read, its CRC
// taken, then its header and bytes written before the next one is read.
//
//   const zip = createZip(res)
//   await zip.add('notes/a.md', 'text or Buffer', mtimeDate?)
//   await zip.end()

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  return { date: Math.max(0, date) & 0xffff, time: time & 0xffff }
}

export function createZip(out) {
  const entries = []
  let offset = 0
  // a download that is cancelled half way must not leave us waiting for 'drain' for ever
  const gone = () => out.destroyed || out.writableEnded || (out.socket && out.socket.destroyed)
  const write = (buf) =>
    new Promise((resolve, reject) => {
      if (gone()) return reject(new Error('download cancelled'))
      offset += buf.length
      if (out.write(buf)) return resolve()
      const done = (err) => {
        out.off?.('drain', ok)
        out.off?.('close', closed)
        out.off?.('error', done)
        if (err) reject(err)
        else resolve()
      }
      const ok = () => done()
      const closed = () => done(new Error('download cancelled'))
      out.once('drain', ok)
      out.once('close', closed)
      out.once('error', done)
    })

  async function add(name, data, mtime = new Date()) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
    const fname = Buffer.from(String(name).replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8')
    const crc = crc32(body)
    const { date, time } = dosTime(mtime)
    if (body.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('zip too large (no zip64)')
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4) // version needed
    head.writeUInt16LE(0x0800, 6) // UTF-8 names
    head.writeUInt16LE(0, 8) // stored
    head.writeUInt16LE(time, 10)
    head.writeUInt16LE(date, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(body.length, 22)
    head.writeUInt16LE(fname.length, 26)
    head.writeUInt16LE(0, 28)
    entries.push({ fname, crc, size: body.length, date, time, offset })
    await write(head)
    await write(fname)
    if (body.length) await write(body)
  }

  async function end() {
    const start = offset
    for (const e of entries) {
      const c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0)
      c.writeUInt16LE(20, 4) // made by
      c.writeUInt16LE(20, 6) // needed
      c.writeUInt16LE(0x0800, 8)
      c.writeUInt16LE(0, 10)
      c.writeUInt16LE(e.time, 12)
      c.writeUInt16LE(e.date, 14)
      c.writeUInt32LE(e.crc, 16)
      c.writeUInt32LE(e.size, 20)
      c.writeUInt32LE(e.size, 24)
      c.writeUInt16LE(e.fname.length, 28)
      c.writeUInt16LE(0, 30) // extra
      c.writeUInt16LE(0, 32) // comment
      c.writeUInt16LE(0, 34) // disk
      c.writeUInt16LE(0, 36) // internal attrs
      c.writeUInt32LE(0, 38) // external attrs
      c.writeUInt32LE(e.offset, 42)
      await write(c)
      await write(e.fname)
    }
    const size = offset - start
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(size, 12)
    eocd.writeUInt32LE(start, 16)
    eocd.writeUInt16LE(0, 20)
    await write(eocd)
    if (typeof out.end === 'function') out.end()
  }

  return { add, end }
}

/** Read a store-only zip back: [{ name, data }] (for tests and import checks). */
export function readZip(buf) {
  const out = []
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a zip')
  const n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory')
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extra = buf.readUInt16LE(p + 30)
    const comment = buf.readUInt16LE(p + 32)
    const off = buf.readUInt32LE(p + 42)
    const crc = buf.readUInt32LE(p + 16)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const lNameLen = buf.readUInt16LE(off + 26)
    const lExtra = buf.readUInt16LE(off + 28)
    const data = buf.subarray(off + 30 + lNameLen + lExtra, off + 30 + lNameLen + lExtra + size)
    if (crc32(data) !== crc) throw new Error('crc mismatch in ' + name)
    out.push({ name, data })
    p += 46 + nameLen + extra + comment
  }
  return out
}
