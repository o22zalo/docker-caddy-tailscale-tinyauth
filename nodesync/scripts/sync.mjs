#!/usr/bin/env node
// Sync configured paths từ predecessor do orchestrator discovery ghi ra.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, posix } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, enabledChannels, workspaceDir } from "./lib/env.mjs";
import { log, warn, error } from "./lib/log.mjs";

const cfg=loadConfig(), ws=workspaceDir();
const runtime=process.env.NODESYNC_RUNTIME_DIR||"/runtime";
const predecessorFile=process.env.NODESYNC_PREDECESSOR_FILE||`${runtime}/predecessor.json`;
const keyFile=process.env.NODESYNC_SSH_KEY_FILE||`${runtime}/id_ed25519`;
const knownHosts=`${runtime}/known_hosts`;
const sh=(cmd,args,{timeout=30000}={})=>{const r=spawnSync(cmd,args,{encoding:"utf8",timeout,maxBuffer:32*1024*1024});return{ok:r.status===0,out:(r.stdout||"").trim(),err:(r.stderr||r.error?.message||"").trim(),status:r.status}};
const safePath=(p)=>{if(!p||p.startsWith("/")||p.split(/[\\/]+/).includes("..")||p==="."||p==="ci-runtime")throw new Error(`sync path không an toàn: ${p}`);return p};
const quote=(s)=>`'${String(s).replaceAll("'",`'\\''`)}'`;

function candidates(source){
 const channels=enabledChannels(cfg), out=[];
 for(const channel of channels){
  if(channel==="tailscale" && source.tailscale?.available && source.tailscale?.online){
   const host=source.tailscale.ip||source.tailscale.ips?.[0]; if(host) out.push({channel,host,port:source.ssh.tailscalePort||2222,proxy:`nc -x tailscale:1055 %h %p`});
  }
  if(channel==="cloudflare" && source.domain) for(let retry=1;retry<=3;retry++) out.push({channel,attempt:retry,host:`ssh.${source.domain}`,port:22,proxy:`docker exec -i -e TUNNEL_SERVICE_TOKEN_ID -e TUNNEL_SERVICE_TOKEN_SECRET cloudflared cloudflared access ssh --hostname %h`});
  if(channel==="hybrid") for(const host of source.ssh.ips||[]) out.push({channel,host,port:source.ssh.port||22});
 }
 return out;
}
function knownHostLine(host,port,hostKey){
 const parts=String(hostKey).trim().split(/\s+/); if(parts.length<3) throw new Error("source hostKey không hợp lệ");
 return `${port===22?host:`[${host}]:${port}`} ${parts.slice(1).join(" ")}\n`;
}
function sshArgs(c){return ["-o","BatchMode=yes","-o","PasswordAuthentication=no","-o","StrictHostKeyChecking=yes","-o",`UserKnownHostsFile=${knownHosts}`,"-o","IdentitiesOnly=yes","-o","ConnectTimeout=10","-i",keyFile,"-p",String(c.port),...(c.proxy?["-o",`ProxyCommand=${c.proxy}`]:[])];}
function connect(source){
 if(!existsSync(keyFile)) throw new Error(`thiếu private key ${keyFile}`);
 for(const c of candidates(source)){
  writeFileSync(knownHosts,knownHostLine(c.host,c.port,source.ssh.hostKey),{mode:0o600});
  const target=`${source.ssh.user}@${c.host}`;
  const identity=sh("ssh",[...sshArgs(c),target,`cat ${quote(source.ssh.identityFile)}`],{timeout:30000});
  if(identity.ok && identity.out.trim()===source.nodeId){log(`SSH verified channel=${c.channel} attempt=${c.attempt||1} source=${source.nodeId} endpoint=${c.host}:${c.port}`);return{...c,target,args:sshArgs(c)}}
  warn(`Channel ${c.channel} attempt=${c.attempt||1} rejected: ${identity.err||`identity=${identity.out||"missing"}`}`);
 }
 throw new Error(`Không channel nào xác minh đúng predecessor ${source.nodeId}`);
}
function main(){
 log("=== NODESYNC dynamic predecessor sync ===");
 if(!cfg.sync_paths.length){log("Không có file/folder cấu hình để sync; không kết nối SSH.");return;}
 if(!existsSync(predecessorFile))throw new Error(`thiếu discovery manifest ${predecessorFile}`);
 const {source,selfId}=JSON.parse(readFileSync(predecessorFile,"utf8"));
 if(!source){log(`Runner ${selfId} không có predecessor (runner lên đầu tiên); bỏ qua sync.`);return;}
 const conn=connect(source), remoteRoot=String(source.ssh.workspace||ws).replace(/\/$/,"");
 for(const raw of cfg.sync_paths){
  const rel=safePath(raw), local=resolve(ws,rel); mkdirSync(local,{recursive:true});
  const sshCmd=["ssh",...conn.args].map(quote).join(" ");
  log(`Sync path=${rel} source=${source.nodeId} → current=${selfId}`);
  const r=sh("rsync",[...cfg.rsync_options,"-e",sshCmd,`${conn.target}:${remoteRoot}/${posix.normalize(rel)}/`,`${local}/`],{timeout:(cfg.sync_timeout_seconds||600)*1000});
  if(!r.ok)throw new Error(`rsync ${rel} lỗi: ${r.err}`); log(r.out);
 }
 log(`NODESYNC PASS source=${source.nodeId} current=${selfId} paths=${cfg.sync_paths.length}`);
}
try{main()}catch(e){error(e.stack||e.message);process.exit(1)}
