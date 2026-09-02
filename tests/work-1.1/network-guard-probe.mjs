import assert from 'node:assert/strict'
import dns from 'node:dns'
import dgram from 'node:dgram'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
async function denied(label,operation){try{await operation();assert.fail(`${label} was not denied`)}catch(error){assert.match(String(error),/network disabled by work-1\.1 import guard/)}}
async function deniedRequest(label,module,url){await new Promise((resolve,reject)=>{let request;const timer=setTimeout(()=>{request?.destroy();reject(new Error(`${label} did not reach network guard`))},1000);try{request=module.get(url);request.once('error',error=>{clearTimeout(timer);try{assert.match(String(error),/network disabled by work-1\.1 import guard/);resolve()}catch(assertion){reject(assertion)}})}catch(error){clearTimeout(timer);try{assert.match(String(error),/network disabled by work-1\.1 import guard/);resolve()}catch(assertion){reject(assertion)}}})}
await denied('dns.lookup',()=>dns.promises.lookup('example.invalid'));await denied('dns.resolve',()=>dns.promises.resolve('example.invalid'));await denied('dgram.createSocket',()=>dgram.createSocket('udp4'));await denied('net.connect',()=>net.connect(80,'example.invalid'));await denied('fetch',()=>fetch('https://example.invalid'));await deniedRequest('http.get',http,'http://example.invalid');await deniedRequest('https.get',https,'https://example.invalid');console.log(JSON.stringify({ok:true,denied:['dns.lookup','dns.resolve','dgram.createSocket','net.connect','fetch','http.get','https.get']}))
