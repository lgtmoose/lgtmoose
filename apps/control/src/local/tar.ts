/**
 * A minimal uncompressed (ustar) tar writer and reader, for the batch files the runner copies
 * into and out of a sandbox container (Docker's archive API speaks tar). Regular files and
 * directories only; the reader skips everything else, so a sandbox can't hand back a symlink
 * or a device.
 */

export interface TarEntry {
  /** Path inside the archive, `/`-separated, relative. */
  name: string;
  /** Undefined for a directory. */
  body?: Buffer;
  mode: number;
  uid: number;
  gid: number;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(entry: TarEntry): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  const directory = entry.body === undefined;
  const name = directory && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
  if (Buffer.byteLength(name) > 100) throw new Error(`Tar name too long: ${name}`);
  block.write(name, 0, 100, "utf8");
  block.write(octal(entry.mode & 0o7777, 8), 100, 8, "ascii");
  block.write(octal(entry.uid, 8), 108, 8, "ascii");
  block.write(octal(entry.gid, 8), 116, 8, "ascii");
  block.write(octal(entry.body?.length ?? 0, 12), 124, 12, "ascii");
  block.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(directory ? "5" : "0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

/** An uncompressed tar archive of `entries`, in order. */
export function writeTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry));
    if (entry.body !== undefined) {
      parts.push(entry.body);
      const pad = (BLOCK - (entry.body.length % BLOCK)) % BLOCK;
      if (pad > 0) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/**
 * The regular files in a tar archive, by name. Names are left as they are; callers decide which
 * they want. Stops at `maxBytes` of file content in total, so a sandbox can't fill the runner's
 * memory.
 */
export function readTar(archive: Buffer, maxBytes: number): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let total = 0;
  let longName: string | undefined;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(block, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(block[156] ?? 0);
    const prefix = field(block, 345, 155);
    const base = field(block, 0, 100);
    const name = longName ?? (prefix === "" ? base : `${prefix}/${base}`);
    longName = undefined;
    const start = offset + BLOCK;
    const body = archive.subarray(start, start + size);
    if (type === "L") {
      // GNU long name for the next entry.
      longName = body.toString("utf8").replace(/\0+$/, "");
    } else if (type === "0" || type === "\0") {
      total += size;
      if (total > maxBytes) throw new Error(`The sandbox's files are over ${maxBytes} bytes.`);
      files.set(name, Buffer.from(body));
    }
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
