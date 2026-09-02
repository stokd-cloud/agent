
import { ensureRepositoryTarget } from './lib/repository-target.mjs'
import { parseArgs, requireValue } from './lib/args.mjs'
try {
  const args=parseArgs(process.argv.slice(2))
  const result=ensureRepositoryTarget({repoPath:requireValue(args,'repo'),expectedOrigin:requireValue(args,'origin'),expectedUpstream:requireValue(args,'upstream'),bootstrapUpstream:args.flags.has('bootstrap-upstream')})
  console.log(JSON.stringify(result)); process.exitCode=0
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode=error?.exitCode ?? 2
}
