/** Write a large text body to R2 incrementally using multipart upload (parts >= 5MiB). */
export class R2TextWriter {
  private enc = new TextEncoder()
  private chunks: Uint8Array[] = []
  private size = 0
  private upload: R2MultipartUpload | null = null
  private parts: R2UploadedPart[] = []
  private static PART = 8 * 1024 * 1024

  constructor(
    private bucket: R2Bucket,
    private key: string,
    private opts: R2PutOptions = {},
  ) {}

  async write(s: string) {
    const b = this.enc.encode(s)
    this.chunks.push(b)
    this.size += b.byteLength
    if (this.size >= R2TextWriter.PART) await this.flushPart()
  }

  private concat() {
    const out = new Uint8Array(this.size)
    let o = 0
    for (const c of this.chunks) {
      out.set(c, o)
      o += c.byteLength
    }
    this.chunks = []
    this.size = 0
    return out
  }

  private async flushPart() {
    this.upload ??= await this.bucket.createMultipartUpload(this.key, this.opts)
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, this.concat()))
  }

  async close() {
    if (!this.upload) {
      await this.bucket.put(this.key, this.concat(), this.opts)
      return
    }
    if (this.size) await this.flushPart()
    await this.upload.complete(this.parts)
  }

  async abort() {
    await this.upload?.abort().catch(() => {})
  }
}
