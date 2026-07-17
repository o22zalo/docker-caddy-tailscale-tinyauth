#!/usr/bin/env node
// Configure host sshd and publish pinned connection metadata without prompts.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, parse, resolve } from "node:path";
import { parseEnv } from "../lib/env-utils.mjs";
const ROOT=resolve(import.meta.dirname,"../.."),ENV=resolve(ROOT,".env"),env={...(existsSync(ENV)?parseEnv(ENV):{}),...process.env};
const enabled=/^(1|true|yes|on)$/i.test(env.SSH_ENABLE||"0"),dry=process.argv.includes("--dry-run"),runtime=resolve(ROOT,"ci-runtime/nodesync");
const keyFile=resolve(runtime,"id_ed25519"),identityFile=resolve(runtime,"node-id"),manifestFile=resolve(runtime,"host-ssh.json"),nodeId=env.ORCH_NODE_ID||"local-unknown";
const users=Object.keys(env).map(k=>k.match(/^SSH_(\d+)_USER$/)).filter(Boolean).sort((a,b)=>+a[1]-+b[1]).map(m=>env[m[0]]).filter(Boolean),sshUser=users[0];
const safe=(x)=>String(x).replace(/(password|pass|secret|token|private[_-]?key)=\S+/gi,"$1=<hidden>");
function run(cmd,args,opt={}){console.log(`[nodesync-ssh] ${safe(cmd+" "+args.join(" "))}`);if(dry)return"";const out=execFileSync(cmd,args,{encoding:"utf8",input:opt.input,stdio:opt.capture?["pipe","pipe","pipe"]:"inherit"});return typeof out==="string"?out.trim():""}
const sudo=(cmd,args,opt)=>process.getuid?.()===0?run(cmd,args,opt):run("sudo",["-n",cmd,...args],opt);
const truthy=(v)=>/^(1|true|yes|on)$/i.test(String(v??"0"));
const syncPaths=String(env.SSH_SYNC_PATHS||(truthy(env.SSH_SYNC_SMOKE_ENABLE)?"ci-runtime/smoke-sync-data":"")).split(",").map(x=>x.trim()).filter(Boolean);
function safeSyncPath(p){if(!p||p.startsWith("/")||p.split(/[\\/]+/).includes("..")||p==="."||p==="ci-runtime")throw new Error(`unsafe sync path: ${p}`);return p}
function grantSyncReads(){
 for(const raw of syncPaths){
  const rel=safeSyncPath(raw),target=resolve(ROOT,rel);
  if(!existsSync(target))continue;
  const root=parse(target).root;let cur=target;
  while(cur&&cur!==root){cur=dirname(cur);if(existsSync(cur))sudo("chmod",["a+X",cur])}
  sudo("chmod",["-R","a+rX",target]);
 }
}
if(!enabled){console.log("[nodesync-ssh] disabled");process.exit(0)}if(!sshUser)throw new Error("Run nodesync ssh:env before bootstrap");
if(dry){console.log(`[nodesync-ssh] DRY RUN node=${nodeId} user=${sshUser}`);process.exit(0)}
mkdirSync(runtime,{recursive:true});if(!existsSync(keyFile))throw new Error(`missing ${keyFile}; run ssh:env`);chmodSync(keyFile,0o600);writeFileSync(identityFile,nodeId+"\n",{mode:0o644});
if(process.platform!=="linux")throw new Error("sshd bootstrap requires Linux");
const install=spawnSync("sh",["-lc","command -v sshd >/dev/null && command -v rsync >/dev/null && command -v sshpass >/dev/null || (sudo -n apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server rsync sshpass)"]);if(install.status!==0)throw new Error("non-interactive SSH dependencies install failed");
sudo("mkdir",["-p","/run/sshd","/etc/ssh/sshd_config.d","/etc/nodesync"]);sudo("install",["-m","0644",identityFile,"/etc/nodesync/node-id"]);
grantSyncReads();
const dropin=["PasswordAuthentication yes","KbdInteractiveAuthentication no","PubkeyAuthentication yes","PermitRootLogin no","UsePAM yes","AllowTcpForwarding no","X11Forwarding no","PermitTTY yes",`AllowUsers ${users.join(" ")}`].join("\n")+"\n";
const tmp=resolve(runtime,"99-nodesync.conf");writeFileSync(tmp,dropin);sudo("install",["-m","0644",tmp,"/etc/ssh/sshd_config.d/99-nodesync.conf"]);sudo("ssh-keygen",["-A"]);sudo("sshd",["-t"]);
if(spawnSync("sh",["-lc","command -v systemctl >/dev/null && systemctl list-unit-files ssh.service >/dev/null 2>&1"]).status===0)sudo("systemctl",["restart","ssh"]);else sudo("sh",["-lc","pkill -HUP sshd || /usr/sbin/sshd"]);
const hostKey=run("ssh-keyscan",["-T","5","-t","ed25519","127.0.0.1"],{capture:true}).split("\n").find(x=>x&&!x.startsWith("#"));if(!hostKey)throw new Error("SSH host key unavailable");
const hostKeyFile=resolve(runtime,"host-ed25519.pub");writeFileSync(hostKeyFile,hostKey+"\n",{mode:0o600});
const fingerprint=run("ssh-keygen",["-lf",hostKeyFile],{capture:true}),ips=Object.values(networkInterfaces()).flat().filter(x=>x&&!x.internal).map(x=>x.address);
const manifest={version:2,nodeId,user:sshUser,users,port:22,tailscalePort:2222,host:hostname(),ips,workspace:ROOT,hostKey,fingerprint,identityFile:"/etc/nodesync/node-id",generatedAt:new Date().toISOString()};writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});
console.log(`[nodesync-ssh] READY users=${users.join(",")} node=${nodeId} fingerprint=${fingerprint}`);
