#!/usr/bin/env node
// Materialise SSH_* configuration and runtime key files for local/GitHub/Azure.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { Writable } from "node:stream";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { maskCiSecret, exportCiVar, parseEnv } from "../../scripts/lib/env-utils.mjs";

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const args=process.argv.slice(2), dry=args.includes("--dry-run");
const envArg=args.indexOf("--env");
const ENV=envArg>=0?resolve(args[envArg+1]):resolve(ROOT,".env");
const runtime=resolve(ROOT,"ci-runtime/nodesync");
const truthy=(v)=>/^(1|true|yes|on)$/i.test(String(v??""));
const interactive=process.stdin.isTTY&&!process.env.GITHUB_ACTIONS&&process.env.TF_BUILD!=="True"&&!dry&&!args.includes("--no-interactive");
let content=existsSync(ENV)?readFileSync(ENV,"utf8"):"";
const fileEnv=existsSync(ENV)?parseEnv(ENV):{}, env={...Object.fromEntries(Object.entries(fileEnv).map(([k,v])=>[k.toUpperCase(),v])),...Object.fromEntries(Object.entries(process.env).map(([k,v])=>[k.toUpperCase(),v]))};
const generated=new Map();

function mask(value){
 maskCiSecret(value);
}
function set(key,value,{secret=false}={}){
 key=key.toUpperCase(); value=String(value??""); env[key]=value; generated.set(key,value);
 if(secret) mask(value);
}
function writePrefix(prefix){
 if(dry)return;
 const lines=content.split(/\r?\n/), values=new Map(Object.entries(env).filter(([key])=>key.startsWith(prefix)));
 let first=-1;
 for(let i=0;i<lines.length;i++){
  const m=lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if(m&&m[1].toUpperCase().startsWith(prefix)){
   if(first<0)first=i;
  }
 }
 for(const [key,value] of generated)if(key.startsWith(prefix))values.set(key,value);
 if(!values.size)return;
 const kept=lines.filter(line=>{const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);return !(m&&m[1].toUpperCase().startsWith(prefix));});
 const insertAt=first<0?kept.length-(kept.at(-1)===""?1:0):Math.min(first,kept.length);
 kept.splice(insertAt,0,...[...values].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`));
 content=kept.join("\n").replace(/\n*$/,"\n");
 writeFileSync(ENV,content,{mode:0o600});
}
function exportPublic(key,value){
 exportCiVar(key,value);
}
async function ask(question,{secret=false,required=false}={}){
 while(true){
  const muted=new Writable({write(chunk,enc,cb){if(!secret)process.stdout.write(chunk,enc);cb();}});
  const rl=readline.createInterface({input:process.stdin,output:secret?muted:process.stdout,terminal:true});
  const answer=(await rl.question(question)).trim();rl.close();if(secret)process.stdout.write("\n");
  if(answer||!required)return answer;
  console.error("Value is required.");
 }
}

if(!truthy(env.SSH_ENABLE)){console.log("[ssh-env] SSH_ENABLE!=1; no SSH materialisation required");process.exit(0)}
mkdirSync(runtime,{recursive:true});
const indexes=new Set();
for(const key of Object.keys(env)){const m=key.match(/^SSH_(\d+)_(?:USER|PASS|PASSWORD|PUBLIC_KEY_BASE64|PRIVATE_KEY_BASE64)/i);if(m)indexes.add(Number(m[1]));}
if(!indexes.size){
 set("SSH_1_USER",env.SSH_DEFAULT_USER||"nodesync");
 indexes.add(1);
}
for(const i of [...indexes].sort((a,b)=>a-b)){
 const fallbackUser=env[`SSH_${i}_USER`]||env.SSH_DEFAULT_USER||`nodesync${i===1?"":i}`;
 const user=interactive?(await ask(`SSH_${i}_USER [${fallbackUser}]: `)||fallbackUser):fallbackUser;
 let pass=env[`SSH_${i}_PASS`]||env[`SSH_${i}_PASSWORD`]||"";
 if(interactive)pass=await ask(`SSH_${i}_PASS (required): `,{secret:true,required:true});
 if(!pass)throw new Error(`SSH_${i}_PASS is required${interactive?"":"; set it in env or run from an interactive terminal"}`);
 set(`SSH_${i}_USER`,user); set(`SSH_${i}_PASS`,pass,{secret:true});
 if(interactive){
  const pasted=await ask(`SSH_${i}_PUBLIC_KEY optional (blank = generated/current): `);
  if(pasted)set(`SSH_${i}_PUBLIC_KEY_BASE64`,Buffer.from(pasted).toString("base64"));
 }
}
const keyFile=resolve(runtime,"id_ed25519"), pubFile=`${keyFile}.pub`;
let privateKey=env.SSH_1_PRIVATE_KEY_BASE64?Buffer.from(env.SSH_1_PRIVATE_KEY_BASE64,"base64").toString("utf8"):"";
let publicKey=env.SSH_1_PUBLIC_KEY_BASE64?Buffer.from(env.SSH_1_PUBLIC_KEY_BASE64,"base64").toString("utf8"):"";
if(!dry){
 if(privateKey){writeFileSync(keyFile,privateKey.trim()+"\n",{mode:0o600});}
 else if(!existsSync(keyFile))execFileSync("ssh-keygen",["-q","-t","ed25519","-N","","-C",`${env.ORCH_NODE_ID||userInfo().username}@nodesync`,"-f",keyFile],{stdio:"inherit"});
 chmodSync(keyFile,0o600);
 if(!publicKey)publicKey=existsSync(pubFile)?readFileSync(pubFile,"utf8").trim():execFileSync("ssh-keygen",["-y","-f",keyFile],{encoding:"utf8"}).trim();
 if(!existsSync(pubFile))writeFileSync(pubFile,publicKey+"\n",{mode:0o644});
 privateKey=readFileSync(keyFile,"utf8").trim();
 set("SSH_1_PRIVATE_KEY_BASE64",Buffer.from(privateKey).toString("base64"),{secret:true});
 set("SSH_1_PUBLIC_KEY_BASE64",Buffer.from(publicKey).toString("base64"));
}
writePrefix("SSH_");
for(const [key,value] of generated)if(!/(PASS|PRIVATE_KEY|SECRET|TOKEN)/.test(key))exportPublic(key,value);
console.log(`[ssh-env] ready users=${indexes.size} env=${ENV} runtime=${runtime} keys=${[...generated.keys()].sort().join(",")}`);
