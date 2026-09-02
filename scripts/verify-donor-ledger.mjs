
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
if(process.env.AGENT_DONOR_LEDGER) throw new Error('AGENT_DONOR_LEDGER override is forbidden for canonical verification')
const ledgerPath=join(root,'tests/donor/case-ledger.json')
assert.equal(createHash('sha256').update(readFileSync(ledgerPath)).digest('hex'),'88945512c7d0279069899031dfd1d79b04c588e32b805c6e1ad45c37b725a35d','canonical donor ledger byte drift')
const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'))
const EXPECTED_DIGEST='0dddd7a01fbf1ee38473c6fb113ac3650c6bde1a2ef883be283d1b5a1c9c6b10'
const canonical=(value)=>JSON.stringify(value,Object.keys(value).sort())
function stable(value) { if(Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if(value&&typeof value==='object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`; return JSON.stringify(value) }
const digest=createHash('sha256').update(stable(ledger)).digest('hex')
assert.equal(digest,EXPECTED_DIGEST,'donor ledger bytes/meaning changed')
assert.equal(ledger.cases.length,112)
assert.equal(new Set(ledger.cases.map(x=>`${x.group}/${x.case}`)).size,112)
assert.deepEqual(ledger.counts,{'render-scroll':26,'input-terminal':20,'session-workspace':22,'channel-ui':42,'flaky-observation':2})
assert.deepEqual(ledger.categoryCounts,{retain_presentation:50,replace_native:60,retain_observation:2})
for(let i=0;i<ledger.cases.length;i+=1) assert.equal(ledger.cases[i].ordinal,i+1)
const source=readFileSync(join(root,'packages/tui/scripts/run-ci-group.mjs'),'utf8')
for(const group of Object.keys(ledger.counts)) {
  const start=source.indexOf(`'${group}': [`); assert.ok(start>=0,`missing donor group ${group}`)
  const next=source.indexOf("\n  ],",start); assert.ok(next>start)
  const cases=[...source.slice(start,next).matchAll(/^\s*\["([^"]+)", \[/gm)].map(m=>m[1])
  assert.deepEqual(cases,ledger.cases.filter(x=>x.group===group).map(x=>x.case),`donor group ${group} changed`)
}
console.log(JSON.stringify({ok:true,digest,count:112,counts:ledger.counts,categoryCounts:ledger.categoryCounts}))
