#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportCiVar, parseEnv } from "../../scripts/lib/env-utils.mjs";

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const args=process.argv.slice(2), envArg=args.indexOf("--env");
const dir=resolve(ROOT,"ci-runtime/smoke-sync-data"), envFile=envArg>=0?resolve(args[envArg+1]):resolve(ROOT,".env");
const truthy=(v)=>/^(1|true|yes|on)$/i.test(String(v??""));
const enabled=truthy(process.env.SSH_SYNC_SMOKE_ENABLE)||(existsSync(envFile)&&truthy(parseEnv(envFile).SSH_SYNC_SMOKE_ENABLE));
if(!enabled){console.log("[ssh-smoke] disabled");process.exit(0)}
const sha=(file)=>createHash("sha256").update(readFileSync(file)).digest("hex");
function inventory(root){
 const files=[],dirs=[]; const walk=(p)=>{for(const e of readdirSync(p,{withFileTypes:true})){const full=resolve(p,e.name),rel=relative(root,full);if(e.isDirectory()){dirs.push(rel);walk(full)}else if(e.isFile())files.push({path:rel,size:statSync(full).size,sha256:sha(full)})}};walk(root);return{files:files.sort((a,b)=>a.path.localeCompare(b.path)),dirs:dirs.sort()};
}
function setEnv(key,value){
 let src=existsSync(envFile)?readFileSync(envFile,"utf8"):""; const line=`${key}=${value}`;
 src=new RegExp(`^${key}=.*$`,"m").test(src)?src.replace(new RegExp(`^${key}=.*$`,"m"),line):src.trimEnd()+`\n${line}\n`;
 writeFileSync(envFile,src);
 exportCiVar(key,value);
}
mkdirSync(resolve(dir,"files"),{recursive:true});mkdirSync(resolve(dir,"tree/a/b"),{recursive:true});
const createdAt=new Date().toISOString(), node=process.env.ORCH_NODE_ID||process.env.GITHUB_RUN_ID||process.env.BUILD_BUILDID||"local";
writeFileSync(resolve(dir,"files/payload.txt"),`node=${node}\ncreatedAt=${createdAt}\nnonce=${randomBytes(16).toString("hex")}\n`);
writeFileSync(resolve(dir,"tree/a/b/nested.json"),JSON.stringify({node,createdAt,kind:"directory-sync"},null,2)+"\n");
const inv=inventory(dir), checksum=createHash("sha256").update(JSON.stringify(inv)).digest("hex");
const manifest={version:1,nodeId:node,createdAt,checksum,...inv};writeFileSync(resolve(dir,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
setEnv("ORCH_META_SSH_SMOKE_CREATED_AT",createdAt);setEnv("ORCH_META_SSH_SMOKE_CHECKSUM",checksum);setEnv("ORCH_META_SSH_SMOKE_FILES",String(inv.files.length));setEnv("ORCH_META_SSH_SMOKE_DIRS",String(inv.dirs.length));
console.log(`[ssh-smoke] prepared path=${relative(ROOT,dir)} time=${createdAt} checksum=${checksum} files=${inv.files.length} dirs=${inv.dirs.length}`);
