import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const root=resolve('.');const checks=['scripts/verify-repository-provenance.mjs','scripts/verify-donor-ledger.mjs'];const results=[];for(const script of checks){const result=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',env:process.env});assert.equal(result.status,0,`${script}\n${result.stdout}\n${result.stderr}`);results.push({script,output:JSON.parse(result.stdout)})}console.log(JSON.stringify({ok:true,checks:results}))
