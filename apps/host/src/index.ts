
import { unsupportedError, type AgentErrorEnvelope } from '@stokd-cloud/agent-protocol'
export interface UnsupportedHostResult { readonly ok:false;readonly error:AgentErrorEnvelope }
export async function startHostSupervisor(): Promise<UnsupportedHostResult>{return{ok:false,error:unsupportedError('agent host supervisor is not implemented')}}
export async function runHost(_argv:readonly string[]=[],io:{readonly stderr:{write(value:string):unknown}}=process):Promise<7>{
 io.stderr.write(`${JSON.stringify({schemaVersion:'1.0',ok:false,error:unsupportedError('agent host supervisor is not implemented')})}\n`);return 7
}
