import { createHmac, randomBytes } from 'node:crypto'
import { chmodSync, openSync, readFileSync, realpathSync, writeFileSync, closeSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const [mode, operationId, ...paths] = process.argv.slice(2)
if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(operationId ?? '')) throw new Error('restore operation ID is invalid')
const guardedRawDirectory = realpathSync('/run/stokd-agent/raw')

function assertRawPath(path, suffix = '.secret') {
  if (!path || resolve(path) !== path || realpathSync(dirname(path)) !== guardedRawDirectory || !basename(path).endsWith(suffix)) {
    throw new Error('restore secret material path is outside the guarded raw directory')
  }
}

function writeOwnerReadOnly(path, bytes) {
  assertRawPath(path)
  const descriptor = openSync(path, 'wx', 0o400)
  try { writeFileSync(descriptor, bytes) } finally { closeSync(descriptor) }
  chmodSync(path, 0o400)
}

function secretBytes(path) {
  assertRawPath(path)
  const bytes = readFileSync(path)
  // AWS CLI text output contributes exactly one terminal newline. Generated
  // values contain none, so removing at most one makes first-run and retry
  // derivation byte-identical without trimming valid secret bytes.
  return bytes.length > 0 && bytes[bytes.length - 1] === 0x0a ? bytes.subarray(0, bytes.length - 1) : bytes
}

if (mode === 'generate') {
  if (paths.length !== 1) throw new Error('generate requires one output path')
  writeOwnerReadOnly(paths[0], randomBytes(48).toString('base64url'))
} else if (mode === 'derive') {
  if (paths.length !== 3) throw new Error('derive requires runtime secret, HMAC output, and session output paths')
  const [runtimeSecretPath, hmacPath, sessionPath] = paths
  const seed = secretBytes(runtimeSecretPath)
  if (seed.byteLength < 32) throw new Error('runtime secret is too short for restore derivation')
  assertRawPath(hmacPath)
  assertRawPath(sessionPath)
  const hmac = createHmac('sha256', seed).update('stokd-agent/offline-receipt/v1\0').update(operationId).digest()
  const session = createHmac('sha256', seed).update('stokd-agent/maintenance-session/v1\0').update(operationId).digest('base64url')
  writeOwnerReadOnly(hmacPath, hmac)
  writeOwnerReadOnly(sessionPath, session)
} else {
  throw new Error('restore secret material mode is invalid')
}
