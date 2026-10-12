/**
 * Minimal QR Code encoder (ISO/IEC 18004) for showing `otpauth://` URIs: byte mode, error correction
 * level M, versions 1–10 (up to 213 bytes), automatic mask selection. Written for ApexOs; no
 * dependencies.
 */

/** Error-correction layout for level M: [EC codewords per block, blocks in group 1, data codewords per group-1 block, blocks in group 2]. Group-2 blocks hold one more data codeword. */
const LEVEL_M: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 0, 0], // (no version 0)
  [10, 1, 16, 0],
  [16, 1, 28, 0],
  [26, 1, 44, 0],
  [18, 2, 32, 0],
  [24, 2, 43, 0],
  [16, 4, 27, 0],
  [18, 4, 31, 0],
  [22, 2, 38, 2],
  [22, 3, 36, 2],
  [26, 4, 43, 1],
];

/** Alignment pattern centre coordinates per version. */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const MAX_VERSION = 10;
const FORMAT_LEVEL_M = 0b00;

export interface QrMatrix {
  /** Modules per side (without the quiet zone). */
  size: number;
  version: number;
  mask: number;
  /** `modules[y][x]`, true = dark. */
  modules: boolean[][];
}

// ---------------------------------------------------------------------------
// Reed–Solomon over GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1
// ---------------------------------------------------------------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i]! ^= gfMultiply(coef, factor)));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Data codewords
// ---------------------------------------------------------------------------

function dataCapacity(version: number): number {
  const [, g1, d1, g2] = LEVEL_M[version]!;
  return g1 * d1 + g2 * (d1 + 1);
}

function encodeData(bytes: Uint8Array, version: number): number[] {
  const capacityBits = dataCapacity(version) * 8;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

/** Splits data into blocks, appends Reed–Solomon codewords and interleaves them. */
function addErrorCorrection(data: number[], version: number): number[] {
  const [ecLength, g1, d1, g2] = LEVEL_M[version]!;
  const divisor = rsDivisor(ecLength);
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (let b = 0; b < g1 + g2; b++) {
    const length = b < g1 ? d1 : d1 + 1;
    const block = data.slice(offset, offset + length);
    offset += length;
    blocks.push({ data: block, ec: rsRemainder(block, divisor) });
  }
  const out: number[] = [];
  for (let i = 0; i <= d1; i++) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]!);
  for (let i = 0; i < ecLength; i++) for (const block of blocks) out.push(block.ec[i]!);
  return out;
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

class Builder {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.reserved[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const positions = ALIGNMENT[this.version]!;
    const last = positions.length - 1;
    positions.forEach((cx, i) =>
      positions.forEach((cy, j) => {
        // Skip the three corners occupied by finder patterns.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        this.drawAlignment(cx, cy);
      }),
    );
    this.drawFormat(0); // reserve the format areas; real bits are drawn after masking
    this.drawVersion();
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  /** Format information: level + mask, BCH(15,5) protected, XOR 0x5412, drawn twice. */
  drawFormat(mask: number): void {
    const data = (FORMAT_LEVEL_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true); // the dark module
  }

  /** Version information (versions 7+): 6 bits + BCH(18,6), drawn twice. */
  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  /** Places codewords in the two-column zigzag, skipping function modules. */
  drawCodewords(codewords: number[]): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the vertical timing pattern column
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (this.reserved[y]![x]) continue;
          if (i < codewords.length * 8) {
            this.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
          // Remainder bits stay light.
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.reserved[y]![x]) continue;
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  /** Standard penalty score (runs, 2×2 blocks, finder-like patterns, dark balance). */
  penalty(): number {
    const { size, modules } = this;
    let score = 0;
    const lines: boolean[][] = [];
    for (let y = 0; y < size; y++) lines.push(modules[y]!);
    for (let x = 0; x < size; x++) lines.push(modules.map((row) => row[x]!));
    const finderLike = [
      [true, false, true, true, true, false, true, false, false, false, false],
      [false, false, false, false, true, false, true, true, true, false, true],
    ];
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= line.length; i++) {
        if (i < line.length && line[i] === line[i - 1]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      for (let i = 0; i + 11 <= line.length; i++) {
        for (const pattern of finderLike) if (pattern.every((v, k) => line[i + k] === v)) score += 40;
      }
    }
    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = modules[y]![x]!;
        if (c) dark++;
        if (x + 1 < size && y + 1 < size && c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) score += 3;
      }
    }
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  }
}

/** Encodes text (UTF-8) as the smallest version that fits, with the mask that scores best. */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= MAX_VERSION && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCapacity(version) * 8) version++;
  if (version > MAX_VERSION) throw new RangeError('Text is too long for a QR code');
  const codewords = addErrorCorrection(encodeData(bytes, version), version);

  let best: { mask: number; score: number; modules: boolean[][] } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const builder = new Builder(version);
    builder.drawFunctionPatterns();
    builder.drawCodewords(codewords);
    builder.applyMask(mask);
    builder.drawFormat(mask);
    const score = builder.penalty();
    if (!best || score < best.score) best = { mask, score, modules: builder.modules };
  }
  return { size: version * 4 + 17, version, mask: best!.mask, modules: best!.modules };
}

/** SVG path data (one unit per module, no quiet zone) with horizontal runs merged. */
export function qrSvgPath(qr: QrMatrix): string {
  const parts: string[] = [];
  qr.modules.forEach((row, y) => {
    for (let x = 0; x < qr.size; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < qr.size && row[end]) end++;
      parts.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  });
  return parts.join('');
}
