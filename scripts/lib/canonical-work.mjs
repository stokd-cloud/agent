import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, normalize, relative, sep } from 'node:path'
function inside(root,path){const rel=relative(root,path);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`)}
export function validateCanonicalScenarioCommands(root,item,entry){
 const canonicalRoot=realpathSync(root);const allowedPrefix=`tests/work-${item}/`;const allowedRoot=realpathSync(`${root}/tests/work-${item}`);const observed=[]
 for(const scenario of entry.scenarios){const command=scenario.command;if(!Array.isArray(command)||command.length!==2||command[0]!=='node')throw new Error(`noncanonical command for scenario ${scenario.id}`);const script=command[1];if(typeof script!=='string'||isAbsolute(script)||normalize(script)!==script||!script.endsWith('.mjs')||!script.startsWith(allowedPrefix))throw new Error(`noncanonical script for scenario ${scenario.id}: ${String(script)}`);const canonicalScript=realpathSync(`${canonicalRoot}/${script}`);if(!inside(allowedRoot,canonicalScript)||!statSync(canonicalScript).isFile())throw new Error(`scenario script escapes canonical work directory: ${scenario.id}`);observed.push({id:scenario.id,script,canonicalScript})}
 return observed
}
