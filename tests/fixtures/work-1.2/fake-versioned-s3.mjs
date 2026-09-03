import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function decodeAwsChunked(body) {
  const decoded = []
  let offset = 0
  while (offset < body.byteLength) {
    const headerEnd = body.indexOf('\r\n', offset)
    if (headerEnd < 0) throw new Error('invalid aws-chunked fixture body')
    const size = Number.parseInt(body.subarray(offset, headerEnd).toString('ascii').split(';', 1)[0], 16)
    if (!Number.isSafeInteger(size)) throw new Error('invalid aws-chunked fixture size')
    offset = headerEnd + 2
    if (size === 0) break
    decoded.push(body.subarray(offset, offset + size))
    offset += size + 2
  }
  return Buffer.concat(decoded)
}

export class FakeVersionedS3 {
  constructor() {
    this.server = null
    this.endpoint = null
    this.versions = new Map()
    this.copyCount = 0
    this.copyGates = new Map()
  }
  key(bucket, objectKey) { return `${bucket}\0${objectKey}` }
  rows(bucket, objectKey) { return this.versions.get(this.key(bucket, objectKey)) ?? [] }
  put({ bucket, objectKey, bytes, kmsKeyId, metadata = {} }) {
    const body = Buffer.from(bytes)
    const version = {
      bucket,
      objectKey,
      versionId: `fake-${randomUUID()}`,
      body,
      eTag: digest(body).slice(0, 32),
      kmsKeyId,
      metadata: { ...metadata },
      lastModified: new Date(),
    }
    const rows = this.rows(bucket, objectKey)
    this.versions.set(this.key(bucket, objectKey), [version, ...rows])
    return this.custody(version)
  }
  custody(version) {
    return {
      bucket: version.bucket,
      objectKey: version.objectKey,
      versionId: version.versionId,
      eTag: version.eTag,
      sha256: version.metadata.sha256 ?? digest(version.body),
      byteLength: version.body.byteLength,
      kmsKeyId: version.kmsKeyId,
      capturedAt: version.lastModified.toISOString(),
    }
  }
  exact(record) { return this.rows(record.bucket, record.objectKey).find(value => value.versionId === record.versionId) }
  deleteVersion(record) {
    const rows = this.rows(record.bucket, record.objectKey)
    const retained = rows.filter(value => value.versionId !== record.versionId)
    if (retained.length === rows.length) throw new Error('fake S3 version to delete is absent')
    this.versions.set(this.key(record.bucket, record.objectKey), retained)
  }
  bytes(record) {
    const version = this.exact(record)
    if (!version) throw new Error('fake S3 version is absent')
    return version.body
  }
  matchingTargetCopies(bucket, objectKey, sourceBinding) {
    return this.rows(bucket, objectKey).filter(value => value.metadata['source-custody-sha256'] === sourceBinding)
  }
  blockNextCopy(objectKey) {
    let announce
    let release
    const entered = new Promise(resolve => { announce = resolve })
    const gate = new Promise(resolve => { release = resolve })
    this.copyGates.set(objectKey, { announce, gate })
    return { entered, release: success => release(success) }
  }

  async start() {
    if (this.server) throw new Error('fake S3 is already running')
    this.server = createServer((request, response) => { void this.handle(request, response).catch(error => {
      response.writeHead(500, { 'content-type': 'application/xml' })
      response.end(`<Error><Code>InternalError</Code><Message>${xml(error instanceof Error ? error.message : String(error))}</Message></Error>`)
    }) })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.endpoint = `http://127.0.0.1:${this.server.address().port}`
    return this.endpoint
  }
  async stop() {
    if (!this.server) return
    await new Promise((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
    this.server = null
  }
  async requestBody(request) {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }
  parse(url) {
    const parsed = new URL(url, this.endpoint)
    const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    return { parsed, bucket: segments.shift() ?? '', objectKey: segments.join('/') }
  }
  metadata(headers) {
    return Object.fromEntries(Object.entries(headers).filter(([key]) => key.startsWith('x-amz-meta-')).map(([key, value]) => [key.slice('x-amz-meta-'.length), String(value)]))
  }
  async handle(request, response) {
    const { parsed, bucket, objectKey } = this.parse(request.url)
    if (request.method === 'PUT' && request.headers['x-amz-copy-source']) {
      const raw = decodeURIComponent(String(request.headers['x-amz-copy-source'])).replace(/^\//, '')
      const [sourcePath, query = ''] = raw.split('?')
      const slash = sourcePath.indexOf('/')
      const sourceBucket = sourcePath.slice(0, slash)
      const sourceKey = sourcePath.slice(slash + 1)
      const sourceVersionId = new URLSearchParams(query).get('versionId')
      const source = this.rows(sourceBucket, sourceKey).find(value => value.versionId === sourceVersionId)
      if (!source) return this.notFound(response, 'NoSuchVersion')
      const gate = this.copyGates.get(objectKey)
      if (gate) {
        this.copyGates.delete(objectKey)
        gate.announce()
        if (await gate.gate !== true) {
          response.writeHead(503, { 'content-type': 'application/xml' })
          response.end('<Error><Code>SlowDown</Code><Message>fixture interruption</Message></Error>')
          return
        }
      }
      const target = this.put({
        bucket,
        objectKey,
        bytes: source.body,
        kmsKeyId: String(request.headers['x-amz-server-side-encryption-aws-kms-key-id'] ?? ''),
        metadata: this.metadata(request.headers),
      })
      this.copyCount += 1
      response.writeHead(200, { 'content-type': 'application/xml', 'x-amz-version-id': target.versionId })
      response.end(`<CopyObjectResult><LastModified>${xml(target.capturedAt)}</LastModified><ETag>&quot;${xml(target.eTag)}&quot;</ETag></CopyObjectResult>`)
      return
    }
    if (request.method === 'PUT') {
      const rawBody = await this.requestBody(request)
      const body = String(request.headers['content-encoding'] ?? '').split(',').map(value => value.trim()).includes('aws-chunked') ? decodeAwsChunked(rawBody) : rawBody
      const target = this.put({
        bucket,
        objectKey,
        bytes: body,
        kmsKeyId: String(request.headers['x-amz-server-side-encryption-aws-kms-key-id'] ?? ''),
        metadata: this.metadata(request.headers),
      })
      response.writeHead(200, { etag: `"${target.eTag}"`, 'x-amz-version-id': target.versionId })
      response.end()
      return
    }
    if (request.method === 'HEAD') {
      const versionId = parsed.searchParams.get('versionId')
      const version = this.rows(bucket, objectKey).find(value => value.versionId === versionId)
      if (!version) return this.notFound(response, 'NoSuchVersion')
      const headers = {
        etag: `"${version.eTag}"`,
        'content-length': String(version.body.byteLength),
        'last-modified': version.lastModified.toUTCString(),
        'x-amz-version-id': version.versionId,
        'x-amz-server-side-encryption': 'aws:kms',
        'x-amz-server-side-encryption-aws-kms-key-id': version.kmsKeyId,
      }
      for (const [key, value] of Object.entries(version.metadata)) headers[`x-amz-meta-${key}`] = value
      response.writeHead(200, headers)
      response.end()
      return
    }
    if (request.method === 'GET' && parsed.searchParams.has('versions')) {
      const prefix = parsed.searchParams.get('prefix') ?? ''
      const rows = [...this.versions.values()].flat().filter(value => value.bucket === bucket && value.objectKey.startsWith(prefix))
      response.writeHead(200, { 'content-type': 'application/xml' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xml(bucket)}</Name><Prefix>${xml(prefix)}</Prefix><IsTruncated>false</IsTruncated>${rows.map(value => `<Version><Key>${xml(value.objectKey)}</Key><VersionId>${xml(value.versionId)}</VersionId><IsLatest>true</IsLatest><LastModified>${value.lastModified.toISOString()}</LastModified><ETag>&quot;${xml(value.eTag)}&quot;</ETag><Size>${value.body.byteLength}</Size><StorageClass>STANDARD</StorageClass></Version>`).join('')}</ListVersionsResult>`)
      return
    }
    return this.notFound(response, 'NoSuchKey')
  }
  notFound(response, code) {
    response.writeHead(404, { 'content-type': 'application/xml' })
    response.end(`<Error><Code>${xml(code)}</Code><Message>not found</Message></Error>`)
  }
}
