// Kotlin's Random(seed) (XorWow) and Java's String.hashCode, reproduced bit for bit, so anything the native
// app draws from a seeded random (organic shapes, confetti, avatars...) comes out identical.

export class KotlinRandom {
  private x: number
  private y: number
  private z: number
  private w: number
  private v: number
  private addend: number

  constructor(seed: number) {
    const seed1 = seed | 0
    const seed2 = seed1 >> 31
    this.x = seed1
    this.y = seed2
    this.z = 0
    this.w = 0
    this.v = ~seed1
    this.addend = (seed1 << 10) ^ (seed2 >>> 4)
    for (let i = 0; i < 64; i++) this.nextInt()
  }

  nextInt(): number {
    let t = this.x
    t = t ^ (t >>> 2)
    this.x = this.y
    this.y = this.z
    this.z = this.w
    const v0 = this.v
    this.w = v0
    t = (t ^ (t << 1)) ^ v0 ^ (v0 << 4)
    this.v = t | 0
    this.addend = (this.addend + 362437) | 0
    return (t + this.addend) | 0
  }

  /** Kotlin nextBits: the upper [bitCount] bits of nextInt(). */
  nextBits(bitCount: number): number {
    if (bitCount === 0) return 0
    return (this.nextInt() >>> (32 - bitCount)) | 0
  }

  nextFloat(): number {
    return (this.nextInt() >>> 8) / (1 << 24)
  }

  nextBoolean(): boolean {
    return this.nextBits(1) !== 0
  }

  /** Kotlin doubleFromParts(nextBits(26), nextBits(27)). */
  nextDouble(): number {
    const hi = this.nextBits(26) >>> 0
    const lo = this.nextBits(27) >>> 0
    return (hi * 2 ** 27 + lo) / 2 ** 53
  }

  /** Kotlin nextInt(from, until), or nextInt(until) when called with one argument. */
  nextIntBetween(from: number, until?: number): number {
    if (until === undefined) { until = from; from = 0 }
    if (until <= from) throw new Error('until must be greater than from')
    const n = (until - from) | 0
    if (n > 0) {
      if ((n & -n) === n) return from + this.nextBits(31 - Math.clz32(n))
      let bits: number
      let v: number
      do {
        bits = this.nextInt() >>> 1
        v = bits % n
      } while (((bits - v + (n - 1)) | 0) < 0)
      return from + v
    }
    // Range wider than Int.MAX_VALUE.
    for (;;) {
      const r = this.nextInt()
      if (r >= from && r < until) return r
    }
  }
}

/** Java's String.hashCode, often used by native apps to seed randoms from a name. */
export function hashCode(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return h
}

