
import { appendFileSync } from 'node:fs'
export async function resolve(specifier,context,nextResolve){
 const result=await nextResolve(specifier,context)
 if(process.env.AGENT_MODULE_TRACE&&result.url.startsWith('file:'))appendFileSync(process.env.AGENT_MODULE_TRACE,`${result.url}\n`)
 return result
}
