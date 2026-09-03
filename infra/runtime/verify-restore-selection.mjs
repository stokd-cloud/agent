import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const [manifestPath, bucket, key, versionId, sha256, byteLengthRaw, kmsKeyId, eTag, capturedAt] = process.argv.slice(2)
if (!manifestPath || resolve(manifestPath) !== manifestPath || realpathSync(manifestPath) !== manifestPath) throw new Error('manifest path is not canonical')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const custody = manifest?.archive?.custody
const expectedLength = Number(byteLengthRaw)
if (
  manifest?.archive?.format !== 'mongodump-archive-gzip' || manifest?.archive?.fullReplicaSet !== true || manifest?.archive?.oplogIncluded !== true ||
  manifest.archive.sha256 !== sha256 || manifest.archive.byteLength !== expectedLength ||
  custody?.bucket !== bucket || custody?.objectKey !== key || custody?.versionId !== versionId ||
  custody?.sha256 !== sha256 || custody?.byteLength !== expectedLength || custody?.kmsKeyId !== kmsKeyId || custody?.eTag !== eTag || custody?.capturedAt !== capturedAt
) throw new Error('selected archive bucket/key/VersionId does not match the signed manifest custody')
const ids = manifest.sourceSecretVersionIds
if (!ids || Object.keys(ids).sort().join(',') !== 'backup,migration,runtime') throw new Error('manifest source secret VersionIds have the wrong shape')
for (const key of ['runtime', 'migration', 'backup']) {
  if (!/^[A-Za-z0-9-]{32,64}$/.test(ids[key] ?? '')) throw new Error(`manifest omitted exact ${key} source secret VersionId`)
}
process.stdout.write([ids.runtime, ids.migration, ids.backup].join('\t') + '\n')
