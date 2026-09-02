
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export class RepositoryNameCollisionError extends Error { constructor(message) { super(message); this.name='RepositoryNameCollisionError'; this.exitCode=7 } }
function normalize(url) { return url.trim().replace(/\.git$/,'').replace(/\/$/,'').toLowerCase() }
function git(repo,args,{missing=false}={}) {
  const result=spawnSync('git',['-C',repo,...args],{encoding:'utf8'})
  if(result.status!==0){if(missing)return null;throw new RepositoryNameCollisionError(`existing path is not an inspectable Git repository: ${repo}`)}
  return result.stdout.trim()
}
function identity(repoPath,expectedOrigin,expectedUpstream) {
  if (!existsSync(repoPath)) return {status:'available',repoPath}
  git(repoPath,['rev-parse','--git-dir'])
  const origin=git(repoPath,['remote','get-url','origin'],{missing:true})
  if(!origin || normalize(origin)!==normalize(expectedOrigin)) throw new RepositoryNameCollisionError(`refusing unresolved existing repository origin collision at ${repoPath}`)
  const upstream=git(repoPath,['remote','get-url','upstream'],{missing:true})
  if(upstream && normalize(upstream)!==normalize(expectedUpstream)) throw new RepositoryNameCollisionError(`refusing unresolved existing repository upstream collision at ${repoPath}`)
  return {status:upstream?'existing-authorized-fork':'existing-authorized-fork-missing-upstream',repoPath,origin,upstream,head:git(repoPath,['rev-parse','HEAD'],{missing:true})}
}
export function inspectRepositoryTarget(options) { return identity(options.repoPath,options.expectedOrigin,options.expectedUpstream) }
export function ensureRepositoryTarget({repoPath,expectedOrigin,expectedUpstream,bootstrapUpstream=false}) {
  const inspected=identity(repoPath,expectedOrigin,expectedUpstream)
  if(inspected.status==='available') return inspected
  if(inspected.status==='existing-authorized-fork-missing-upstream') {
    if(!bootstrapUpstream) throw new RepositoryNameCollisionError(`required upstream remote is missing at ${repoPath}; rerun with explicit bootstrap-upstream`)
    const added=spawnSync('git',['-C',repoPath,'remote','add','upstream',expectedUpstream],{encoding:'utf8'})
    if(added.status!==0) throw new RepositoryNameCollisionError(`could not add required upstream remote at ${repoPath}`)
    return identity(repoPath,expectedOrigin,expectedUpstream)
  }
  return inspected
}
