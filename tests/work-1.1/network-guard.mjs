import dns from 'node:dns'
import dgram from 'node:dgram'
import net from 'node:net'
import tls from 'node:tls'
import { writeFileSync } from 'node:fs'
const trace=[]
function describe(args){return args.map(value=>{try{return typeof value==='string'?value:JSON.stringify(value)}catch{return String(value)}})}
function deny(kind,args){trace.push({kind,args:describe(args)});throw new Error(`network disabled by work-1.1 import guard: ${kind}`)}
const originals={socketConnect:net.Socket.prototype.connect,netConnect:net.connect,netCreateConnection:net.createConnection,tlsConnect:tls.connect,dgramCreateSocket:dgram.createSocket,dnsLookup:dns.lookup,dnsResolve:dns.resolve,dnsResolve4:dns.resolve4,dnsResolve6:dns.resolve6,dnsReverse:dns.reverse,fetch:globalThis.fetch,promisesLookup:dns.promises.lookup,promisesResolve:dns.promises.resolve,promisesResolve4:dns.promises.resolve4,promisesResolve6:dns.promises.resolve6,promisesReverse:dns.promises.reverse}
net.Socket.prototype.connect=function(...args){return deny('net.Socket.connect',args)}
net.connect=(...args)=>deny('net.connect',args);net.createConnection=(...args)=>deny('net.createConnection',args);tls.connect=(...args)=>deny('tls.connect',args);dgram.createSocket=(...args)=>deny('dgram.createSocket',args)
dns.lookup=(...args)=>deny('dns.lookup',args);dns.resolve=(...args)=>deny('dns.resolve',args);dns.resolve4=(...args)=>deny('dns.resolve4',args);dns.resolve6=(...args)=>deny('dns.resolve6',args);dns.reverse=(...args)=>deny('dns.reverse',args)
dns.promises.lookup=(...args)=>deny('dns.promises.lookup',args);dns.promises.resolve=(...args)=>deny('dns.promises.resolve',args);dns.promises.resolve4=(...args)=>deny('dns.promises.resolve4',args);dns.promises.resolve6=(...args)=>deny('dns.promises.resolve6',args);dns.promises.reverse=(...args)=>deny('dns.promises.reverse',args)
globalThis.fetch=async(...args)=>deny('fetch',args)
process.on('exit',()=>{if(process.env.AGENT_NETWORK_TRACE)writeFileSync(process.env.AGENT_NETWORK_TRACE,JSON.stringify(trace,null,2)+'\n')})
export function restoreNetworkGuard(){net.Socket.prototype.connect=originals.socketConnect;net.connect=originals.netConnect;net.createConnection=originals.netCreateConnection;tls.connect=originals.tlsConnect;dgram.createSocket=originals.dgramCreateSocket;dns.lookup=originals.dnsLookup;dns.resolve=originals.dnsResolve;dns.resolve4=originals.dnsResolve4;dns.resolve6=originals.dnsResolve6;dns.reverse=originals.dnsReverse;dns.promises.lookup=originals.promisesLookup;dns.promises.resolve=originals.promisesResolve;dns.promises.resolve4=originals.promisesResolve4;dns.promises.resolve6=originals.promisesResolve6;dns.promises.reverse=originals.promisesReverse;globalThis.fetch=originals.fetch}
