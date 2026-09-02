import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AgentProtocolError, decodeAgentCommand, decodeAgentEvent } from '../../packages/protocol/lib/index.js'
import { SCHEMA_TYPE_FIXTURES } from '../../packages/protocol/lib/schema-type-fixtures.js'
const root=resolve('.');const schemasDir=join(root,'packages/protocol/schemas/v1');const load=name=>JSON.parse(readFileSync(join(schemasDir,`${name}.schema.json`),'utf8'))
function pointer(document,ref){assert.match(ref,/^#\//);return ref.slice(2).split('/').reduce((value,part)=>value[part.replaceAll('~1','/').replaceAll('~0','~')],document)}
function isObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function validate(schema,value,document=schema){
 if(schema.$ref)return validate(pointer(document,schema.$ref),value,document)
 if(schema.allOf&&!schema.allOf.every(item=>validate(item,value,document)))return false
 if(schema.oneOf&&schema.oneOf.filter(item=>validate(item,value,document)).length!==1)return false
 if(schema.not&&validate(schema.not,value,document))return false
 if(Object.hasOwn(schema,'const')&&!Object.is(value,schema.const))return false
 if(schema.enum&&!schema.enum.some(item=>Object.is(item,value)))return false
 if(schema.type){const typed=schema.type==='object'?isObject(value):schema.type==='array'?Array.isArray(value):schema.type==='integer'?Number.isSafeInteger(value):schema.type==='number'?typeof value==='number'&&Number.isFinite(value):schema.type==='null'?value===null:typeof value===schema.type;if(!typed)return false}
 if(typeof value==='string'){if(schema.minLength!==undefined&&value.length<schema.minLength)return false;if(schema.pattern&&!new RegExp(schema.pattern).test(value))return false;if(schema.format==='date-time'&&Number.isNaN(Date.parse(value)))return false}
 if(typeof value==='number'){if(schema.minimum!==undefined&&value<schema.minimum)return false;if(schema.maximum!==undefined&&value>schema.maximum)return false}
 if(Array.isArray(value)){if(schema.items&&!value.every(item=>validate(schema.items,item,document)))return false;if(schema.uniqueItems&&new Set(value.map(item=>JSON.stringify(item))).size!==value.length)return false}
 if(isObject(value)){if(schema.required&&!schema.required.every(key=>Object.hasOwn(value,key)))return false;const properties=schema.properties??{};for(const [key,item] of Object.entries(value)){if(properties[key]){if(!validate(properties[key],item,document))return false}else if(schema.additionalProperties===false)return false}}
 return true
}
const schemaMap={artifact:load('artifact'),authority:load('authority'),context:load('context'),error:load('error'),host:load('host-capabilities'),work:load('work-receipt'),command:load('command'),event:load('event'),ids:load('ids')}
for(const key of ['artifact','authority','context','error','host','work'])assert.equal(validate(schemaMap[key],SCHEMA_TYPE_FIXTURES[key]),true,`${key} TypeScript fixture must satisfy wire schema`)
assert.equal(validate(schemaMap.error,{...SCHEMA_TYPE_FIXTURES.error,exitCode:0}),false,'error schema must reject success exit code')
for(const command of SCHEMA_TYPE_FIXTURES.commands){assert.equal(validate(schemaMap.command,command),true);assert.deepEqual(decodeAgentCommand(command),command)}
assert.equal(validate(schemaMap.event,SCHEMA_TYPE_FIXTURES.event),true);assert.deepEqual(decodeAgentEvent(SCHEMA_TYPE_FIXTURES.event),SCHEMA_TYPE_FIXTURES.event)
for(const value of ['agt_12345678','cmd_12345678','art_12345678'])assert.equal(validate(schemaMap.ids,value),true)
const base=structuredClone(SCHEMA_TYPE_FIXTURES.commands[0]);const status=structuredClone(SCHEMA_TYPE_FIXTURES.commands[1])
const invalidCommands=[
 [{...base,schemaVersion:'2.0'},7,'unsupported major'],
 [{...base,commandType:'shell.run'},7,'unknown command'],
 [Object.fromEntries(Object.entries(base).filter(([key])=>key!=='expectedRevision')),2,'missing revision'],
 [{...status,expectedRevision:1},2,'query revision'],
 [{...base,unexpected:true},2,'extra envelope field'],
 [{...base,payload:{...base.payload,unexpected:true}},2,'extra payload field'],
 [{...base,agentId:'bad'},2,'invalid branded id'],
 [{...SCHEMA_TYPE_FIXTURES.commands[3],payload:{...SCHEMA_TYPE_FIXTURES.commands[3].payload,decision:'maybe'}},2,'bad decision'],
 [{...SCHEMA_TYPE_FIXTURES.commands[2],payload:{...SCHEMA_TYPE_FIXTURES.commands[2].payload,reason:''}},2,'empty optional reason'],
]
for(const [value,exitCode,label] of invalidCommands){assert.equal(validate(schemaMap.command,value),false,`${label} schema rejection`);assert.throws(()=>decodeAgentCommand(value),error=>error instanceof AgentProtocolError&&error.envelope.exitCode===exitCode,`${label} decoder rejection`)}
const event=SCHEMA_TYPE_FIXTURES.event;const informational={...event,schemaVersion:'1.9',eventType:'telemetry.future',stateChanging:false};assert.equal(validate(schemaMap.event,informational),true);assert.equal(decodeAgentEvent(informational).stateChanged,false)
const invalidEvents=[
 [{...event,schemaVersion:'2.0'},7,'unsupported event major'],
 [{...event,schemaVersion:'1.9',eventType:'state.future',stateChanging:true},7,'unknown state-changing event'],
 [{...event,eventId:'bad'},2,'invalid event id'],
 [{...event,unexpected:true},2,'extra event field'],
]
for(const [value,exitCode,label] of invalidEvents){assert.equal(validate(schemaMap.event,value),false,`${label} schema rejection`);assert.throws(()=>decodeAgentEvent(value),error=>error instanceof AgentProtocolError&&error.envelope.exitCode===exitCode,`${label} decoder rejection`)}
console.log(JSON.stringify({ok:true,typedSchemas:6,errorSuccessRejected:true,commandVariants:SCHEMA_TYPE_FIXTURES.commands.length,commandNegativeCases:invalidCommands.length,eventNegativeCases:invalidEvents.length,unknownMinorInformational:'unchanged-state',schemaDecoderParity:true}))
