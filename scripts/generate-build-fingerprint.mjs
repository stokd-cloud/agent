import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeBuildFingerprint } from './lib/build-fingerprint.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');const fingerprint=computeBuildFingerprint(root);writeFileSync(join(root,'tests/verification/build-fingerprint.json'),JSON.stringify(fingerprint,null,2)+'\n');console.log(JSON.stringify({ok:true,sourceFiles:fingerprint.sourcePaths.length,outputFiles:fingerprint.outputPaths.length,sourceSha256:fingerprint.sourceSha256,outputSha256:fingerprint.outputSha256}))
