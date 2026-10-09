// Ghi file .zip kiểu STORE (không nén): đủ để gói WAV, MIDI, lời và JSON vào một file tải về.
// WAV gần như không nén được thêm, nên bỏ nén cho nhanh và không cần thư viện.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export type ZipEntry = { name: string; data: Uint8Array }

/** Ngày giờ kiểu MS-DOS (độ phân giải 2 giây). */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** Gói các file thành một .zip (STORE). Tên file UTF-8 (cờ bit 11) nên giữ được chữ có dấu. */
export function zipStore(entries: ZipEntry[], when = new Date()): Uint8Array {
  const enc = new TextEncoder()
  const { time, date } = dosTime(when)
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const crc = crc32(e.data)
    const size = e.data.length
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // phiên bản cần để giải nén
    lv.setUint16(6, 0x0800, true) // tên UTF-8
    lv.setUint16(8, 0, true) // STORE
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    // extra, comment, disk, internal attr = 0
    cv.setUint32(38, e.name.endsWith('/') ? 0x10 : 0, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)

    locals.push(local, e.data)
    centrals.push(central)
    offset += local.length + size
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const out = new Uint8Array(offset + cdSize + end.length)
  let p = 0
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p)
    p += part.length
  }
  return out
}

/**
 * Đọc các file trong một .zip (để mở lại gói trọn bài). Hỗ trợ STORE (gói do app xuất) và DEFLATE (gói người dùng
 * nén lại bằng phần mềm khác) qua DecompressionStream của trình duyệt. Đọc theo central directory nên không phụ thuộc
 * data descriptor. File hỏng hoặc kiểu nén khác thì ném lỗi tiếng Việt.
 */
export async function unzip(bytes: Uint8Array, want?: (name: string) => boolean): Promise<ZipEntry[]> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('File không phải .zip hợp lệ.')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  const out: ZipEntry[] = []
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Mục lục .zip bị hỏng.')
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localAt = dv.getUint32(p + 42, true)
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/') || (want && !want(name))) continue
    if (dv.getUint32(localAt, true) !== 0x04034b50) throw new Error(`File "${name}" trong .zip bị hỏng.`)
    const start = localAt + 30 + dv.getUint16(localAt + 26, true) + dv.getUint16(localAt + 28, true)
    const raw = bytes.subarray(start, start + csize)
    if (method === 0) out.push({ name, data: raw.slice() })
    else if (method === 8) out.push({ name, data: await inflateRaw(raw) })
    else throw new Error(`File "${name}" nén kiểu ${method}, chưa hỗ trợ.`)
  }
  return out
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('Trình duyệt này không giải nén được .zip nén; hãy dùng gói do app xuất.')
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
