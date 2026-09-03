
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, requireValue } from './lib/args.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
function stable(value) { if(Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if(value&&typeof value==='object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`; return JSON.stringify(value) }
const EXPECTED='81d82ac2d5224f1c485d45c684b90ea23326cc75bc6d373ef72e35283ff10d08'
try {
  if(process.env.AGENT_ALLOW_MOCKS || process.env.AGENT_MOCK_MODE) throw new Error('mock substitution is forbidden for contract verification')
  if(process.env.AGENT_CONTRACT_SETUP==='missing') throw new Error('required contract setup is missing')
  const args=parseArgs(process.argv.slice(2))
  if(process.env.AGENT_CONTRACT_REGISTRY)throw new Error('AGENT_CONTRACT_REGISTRY override is forbidden')
  const path=join(root,'tests/contracts/targets.json')
  const byteSha=createHash('sha256').update(readFileSync(path)).digest('hex');if(byteSha!=='3131efea2a2f9020ffbcdb32bfe9e5e8df3c4d4f17d14c5dcc92f007525b49ff')throw new Error(`canonical contract registry byte mismatch: ${byteSha}`)
  const registry=JSON.parse(readFileSync(path,'utf8'))
  const actual=createHash('sha256').update(stable(registry)).digest('hex')
  if(actual!==EXPECTED) throw new Error(`contract registry mismatch: ${actual}`)
  if(registry.count!==103 || registry.targets.length!==103) throw new Error('contract registry must contain exactly 103 targets')
  if(args.flags.has('list')) {
    for(const target of registry.targets) {
      console.log(`${target.id}\t${target.title}\tsurface=${target.scenarioRequirements.surface}; needs=${target.scenarioRequirements.needs}; evidence=${target.scenarioRequirements.evidence}; registered=${target.registeredScenarios.join(',')||'<blocked>'}`)
    }
    process.exitCode=0
  } else {
    const id=requireValue(args,'target')
    const target=registry.targets.find(x=>x.id===id)
    if(!target) throw new Error(`unknown contract target: ${id}`)
    const scenario=args.values.get('scenario')
    if(scenario!==undefined && !target.registeredScenarios.includes(scenario)) throw new Error(`unknown or undeclared scenario for ${id}: ${scenario}`)
    if(target.registeredScenarios.length===0 || target.implementationStatus==='blocked') throw new Error(`contract target is blocked: ${id}`)
    if(target.implementationStatus!=='sealed') throw new Error(`contract target is implemented but unsealed: ${id}; work checks cannot seal VAL evidence`)
  }
} catch(error) { console.error(error instanceof Error?error.message:String(error)); process.exitCode=2 }
