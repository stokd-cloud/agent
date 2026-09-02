function requireNonemptyStrings(value,label){if(!Array.isArray(value)||value.length===0||value.some(item=>typeof item!=='string'||item.length===0))throw new Error(`${label} must be a non-empty string array`)}
export function validateWorkScenarioMapping(contracts,item,entry){
 const owned=contracts.targets.filter(target=>target.owningWorkItem===item);if(owned.length===0)throw new Error(`no contract targets owned by work item ${item}`)
 const byId=new Map(owned.map(target=>[target.id,target]));const expected=new Set(owned.flatMap(target=>target.registeredScenarios.map(name=>`${target.id}:${name}`)));if(expected.size===0)throw new Error(`work item ${item} owns no registered contract scenarios`)
 if(!Array.isArray(entry.scenarios)||entry.scenarios.length===0)throw new Error(`empty work scenario selection: ${item}`)
 const ids=new Set();const seen=new Map()
 for(const scenario of entry.scenarios){if(!scenario||typeof scenario!=='object'||typeof scenario.id!=='string'||scenario.id.length===0)throw new Error('work scenario is missing id');if(ids.has(scenario.id))throw new Error(`duplicate work scenario id: ${scenario.id}`);ids.add(scenario.id);requireNonemptyStrings(scenario.targets,`${scenario.id}.targets`);requireNonemptyStrings(scenario.registeredScenarios,`${scenario.id}.registeredScenarios`)
  for(const targetId of scenario.targets)if(!byId.has(targetId))throw new Error(`${scenario.id} references target not owned by ${item}: ${targetId}`)
  for(const name of scenario.registeredScenarios){const candidates=scenario.targets.filter(targetId=>byId.get(targetId).registeredScenarios.includes(name));if(candidates.length!==1)throw new Error(`${scenario.id} has unknown or ambiguous registered scenario: ${name}`);const key=`${candidates[0]}:${name}`;if(seen.has(key))throw new Error(`registered scenario mapped more than once: ${key}`);seen.set(key,scenario.id)}
 }
 const missing=[...expected].filter(key=>!seen.has(key));const unknown=[...seen.keys()].filter(key=>!expected.has(key));if(missing.length||unknown.length)throw new Error(`contract scenario coverage mismatch; missing=${missing.join(',')||'<none>'}; unknown=${unknown.join(',')||'<none>'}`)
 return{ownedTargets:[...byId.keys()],registeredScenarioCount:expected.size,scenarioIds:[...ids],mapping:Object.fromEntries([...seen])}
}
export function validateStructureScenarioLinks(structureEntry,workEntry){
 if(!Array.isArray(structureEntry.scenarios)||structureEntry.scenarios.length===0)throw new Error('empty structure scenarios');const workIds=new Set(workEntry.scenarios.map(s=>s.id));const referenced=new Set();const ids=new Set()
 for(const scenario of structureEntry.scenarios){if(!scenario||typeof scenario!=='object'||typeof scenario.id!=='string'||scenario.id.length===0)throw new Error('structure scenario is missing id');if(ids.has(scenario.id))throw new Error(`duplicate structure scenario: ${scenario.id}`);ids.add(scenario.id);requireNonemptyStrings(scenario.workScenarioIds,`${scenario.id}.workScenarioIds`);for(const id of scenario.workScenarioIds){if(!workIds.has(id))throw new Error(`${scenario.id} links unknown work scenario: ${id}`);referenced.add(id)}}
 const missing=[...workIds].filter(id=>!referenced.has(id));if(missing.length)throw new Error(`work scenarios have no structure mapping: ${missing.join(',')}`);return{structureScenarioIds:[...ids],referencedWorkScenarioIds:[...referenced]}
}
