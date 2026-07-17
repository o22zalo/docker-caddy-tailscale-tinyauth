#!/usr/bin/env node
// Predecessor sync with pinned host key; smoke mode verifies all channels independently.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, posix } from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, enabledChannels, workspaceDir, truthy } from "./lib/env.mjs";
import { log, warn, error } from "./lib/log.mjs";
const cfg=loadConfig(),ws=workspaceDir(),runtime=process.env.SSH_RUNTIME_DIR||"/runtime";
const predecessorFile=`${runtime}/predecessor.json`,keyFile=`${runtime}/id_ed25519`,reports=resolve(ws,"ci-runtime/nodesync/reports"),smoke=truthy(process.env.SSH_SYNC_SMOKE_ENABLE);
const authUser=process.env.SSH_1_USER||"",authPass=process.env.SSH_1_PASS||process.env.SSH_1_PASSWORD||"";
const quote=(s)=>`'${String(s).replaceAll("'",`'\\''`)}'`,safePath=(p)=>{if(!p||p.startsWith("/")||p.split(/[\\/]+/).includes("..")||p==="."||p==="ci-runtime")throw new Error(`unsafe sync path: ${p}`);return p};
const redact=(s)=>String(s).replaceAll(keyFile,"<keyFile>").replace(/SSHPASS=\S+/g,"SSHPASS=<hidden>");
const cmdPreview=(cmd,args)=>redact([cmd,...args].map((x)=>/\s/.test(String(x))?quote(x):String(x)).join(" "));
const probeFailure=(probe,source)=>probe.ok?(probe.out.trim()===source.nodeId?"":`node-id-mismatch expected=${source.nodeId} actual=${probe.out||"(empty)"}`):`${/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(probe.err)?"host-key-mismatch":"ssh-failed"} status=${probe.status??"n/a"} stderr=${probe.err||"(none)"}`;
function sourceInfo(channel,source){
 if(channel==="tailscale")return{available:!!source.tailscale?.available,online:!!source.tailscale?.online,ip:source.tailscale?.ip||"",ips:source.tailscale?.ips||[],reason:source.tailscale?.reason||""};
 if(channel==="cloudflare")return{domain:source.domain||"",host:source.domain?`ssh.${source.domain}`:""};
 if(channel==="hybrid")return{ips:source.ssh?.ips||[],port:source.ssh?.port||22};
 return{};
}
function exec(cmd,args,{timeout=30000,env={}}={}){return new Promise(resolveDone=>{const started=Date.now(),p=spawn(cmd,args,{stdio:["ignore","pipe","pipe"],env:{...process.env,...env}});let out="",err="",done=false;const finish=(result)=>{if(done)return;done=true;clearTimeout(timer);resolveDone({...result,out:out.trim(),err:err.trim(),durationMs:Date.now()-started})};p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);p.on("error",e=>finish({ok:false,status:null,err:e.message}));p.on("close",code=>finish({ok:code===0,status:code}));const timer=setTimeout(()=>{p.kill("SIGKILL");finish({ok:false,status:null,err:`timeout ${timeout}ms`})},timeout)})}
function ensureAuthFiles(){if(existsSync(keyFile)||!process.env.SSH_1_PRIVATE_KEY_BASE64)return;mkdirSync(dirname(keyFile),{recursive:true});writeFileSync(keyFile,Buffer.from(process.env.SSH_1_PRIVATE_KEY_BASE64,"base64").toString("utf8").trim()+"\n",{mode:0o600});chmodSync(keyFile,0o600);log(`materialized SSH private key from SSH_1_PRIVATE_KEY_BASE64 to ${keyFile}`)}
// Chọn host tailnet của predecessor: ưu tiên MagicDNS (dnsName) để ổn định,
// fallback tailnet IPv4. dnsName tránh phụ thuộc IP đổi.
function tailscaleHost(source){
  const ts=source.tailscale||{};
  return ts.dnsName||ts.ip||(ts.ips||[]).find(x=>x.includes("."))||(ts.ips||[])[0]||"";
}
// Tailscale có bật SSH trên node predecessor không? (từ node record RTDB)
// tailscale-info ghi `ssh:true` khi `tailscale up --ssh`. Nếu có → dùng
// Tailscale SSH TRỰC TIẾP (Tailscale tự lo auth/authz qua ACL, KHÔNG cần key
// materialize, KHÔNG cần nc/SOCKS proxy tự chế). Nếu không → fallback serve.
function tailscaleSshEnabled(source){
  const ts=source.tailscale||{};
  return !!(ts.available&&ts.online&&ts.ssh===true);
}
function endpoints(source){
  const map={tailscale:[],cloudflare:[],hybrid:[]};
  // ── TAILSCALE ──────────────────────────────────────────────────────────
  if(source.tailscale?.available&&source.tailscale?.online){
    const host=tailscaleHost(source);
    if(host){
      if(tailscaleSshEnabled(source)){
        // Tailscale SSH: kết nối THẲNG tới port 22 trên tailnet, Tailscale nhận
        // diện & uỷ quyền. transport="ts-ssh" → dùng auth mode "ts" (không -i key,
        // không ProxyCommand). Đây là đường ưu tiên (ít lỗi, không proxy tự chế).
        map.tailscale.push({host,port:22,transport:"ts-ssh"});
      }
      // Fallback: userspace Tailscale Serve TCP 2222 → sshd runner, qua SOCKS5.
      map.tailscale.push({host,port:source.ssh?.tailscalePort||2222,proxy:"nc -x tailscale:1055 %h %p",transport:"ts-serve"});
    }
  }
  // ── CLOUDFLARE ─────────────────────────────────────────────────────────
  if(source.domain)for(let attempt=1;attempt<=3;attempt++)map.cloudflare.push({host:`ssh.${source.domain}`,port:22,attempt,proxy:"docker exec -i cloudflared cloudflared access ssh --hostname %h"});
  // ── HYBRID (direct IP, cùng L2/L3) ─────────────────────────────────────
  // CHỈ nhận IP có khả năng route được. Loại: IPv6 link-local (fe80:),
  // loopback, docker bridge/overlay (172.16–31.x, 10.x thường không cross-VM),
  // và các dải ephemeral runner không route giữa node. Ưu tiên IPv4 public
  // hoặc IP LAN thực (192.168.x). tailnet IP (100.64/10 CGNAT) đã đi kênh
  // tailscale nên bỏ ở hybrid.
  for(const host of source.ssh?.ips||[]){
    if(!host||typeof host!=="string")continue;
    if(/^fe80:/i.test(host))continue;                 // IPv6 link-local
    if(/^(127\.|::1$|169\.254\.)/.test(host))continue; // loopback / APIPA
    if(/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host))continue; // tailnet CGNAT 100.64/10
    if(/^172\.(1[6-9]|2\d|3[01])\./.test(host))continue; // docker bridge/overlay
    if(/^10\./.test(host)&&truthy(process.env.SSH_HYBRID_ALLOW_10,"0")===false)continue; // 10.x thường private per-VM
    map.hybrid.push({host,port:source.ssh?.port||22});
  }
  return map;
}
function sshArgs(c,source,channel,auth="key"){
  const common=["-o","KbdInteractiveAuthentication=no","-o","StrictHostKeyChecking=no","-o",`ConnectTimeout=${cfg.ssh_connect_timeout_seconds||10}`,"-p",String(c.port),...(c.proxy?["-o",`ProxyCommand=${c.proxy}`]:[])];
  if(auth==="ts"){
    // Tailscale SSH: Tailscale (WireGuard identity + ACL) lo auth. KHÔNG dùng
    // key file, KHÔNG password. Tắt pubkey/password để ssh không hỏi gì thêm.
    return["-o","BatchMode=yes","-o","PasswordAuthentication=no","-o","PubkeyAuthentication=no",...common];
  }
  return["-o",`BatchMode=${auth==="key"?"yes":"no"}`,"-o",`PasswordAuthentication=${auth==="password"?"yes":"no"}`,"-o",`IdentitiesOnly=${auth==="key"?"yes":"no"}`,...(auth==="key"?["-i",keyFile]:[]),...common];
}
// authModes phụ thuộc endpoint: endpoint Tailscale-SSH (transport==="ts-ssh")
// CHỈ dùng auth "ts" (Tailscale tự xác thực). Các endpoint khác dùng key/password.
function authModes(endpoint){
  if(endpoint?.transport==="ts-ssh")return[{name:"ts",cmd:"ssh",prefix:[],env:{}}];
  const out=[];
  if(existsSync(keyFile))out.push({name:"key",cmd:"ssh",prefix:[],env:{}});
  if(authPass)out.push({name:"password",cmd:"sshpass",prefix:["-e","ssh"],env:{SSHPASS:authPass}});
  return out;
}
function inventory(root,{exclude=[]}={}){const files=[],dirs=[];if(!existsSync(root))return{files,dirs,checksum:null};const ignored=new Set(exclude);const walk=p=>{for(const e of readdirSync(p,{withFileTypes:true})){const full=resolve(p,e.name),rel=relative(root,full);if(ignored.has(rel))continue;if(e.isDirectory()){dirs.push(rel);walk(full)}else if(e.isFile()){const data=readFileSync(full);files.push({path:rel,size:statSync(full).size,sha256:createHash("sha256").update(data).digest("hex")})}}};walk(root);files.sort((a,b)=>a.path.localeCompare(b.path));dirs.sort();return{files,dirs,checksum:createHash("sha256").update(JSON.stringify({files,dirs})).digest("hex")}}
function verifySmoke(root){const file=resolve(root,"manifest.json");if(!existsSync(file))throw new Error("smoke manifest missing after rsync");const manifest=JSON.parse(readFileSync(file,"utf8")),actual=inventory(root,{exclude:["manifest.json"]});const verified=actual.checksum===manifest.checksum;if(!verified)throw new Error(`smoke checksum mismatch expected=${manifest.checksum} actual=${actual.checksum}`);return{expectedChecksum:manifest.checksum,checksumVerified:true,sourceCreatedAt:manifest.createdAt}}

async function syncChannel(channel,source,selfId){
 const startedAt=new Date().toISOString(),begin=Date.now(),report={version:1,channel,source:source.nodeId,current:selfId,startedAt,status:"failed",sourceInfo:sourceInfo(channel,source),attempts:[],endpointMetadata:[]};
 try{
  const list=endpoints(source)[channel]||[];report.endpointMetadata=list.map(c=>({host:c.host,port:c.port,attempt:c.attempt||1,proxy:c.proxy||"",transport:c.transport||""}));log(`channel=${channel} sourceInfo=${JSON.stringify(report.sourceInfo)} endpoints=${JSON.stringify(report.endpointMetadata)} paths=${cfg.sync_paths.join(",")}`);
  if(!list.length)throw new Error(`no endpoint metadata sourceInfo=${JSON.stringify(report.sourceInfo)}`);
  outer:for(const c of list){
   const modes=authModes(c);
   if(!modes.length){report.attempts.push({endpoint:`${c.host}:${c.port}`,transport:c.transport||"",error:"no auth mode (no key/password and endpoint not Tailscale-SSH)"});continue}
   for(const auth of modes){
   const args=sshArgs(c,source,channel,auth.name),target=`${authUser||source.ssh.user}@${c.host}`,probeArgs=[...auth.prefix,...args,target,`cat ${quote(source.ssh.identityFile)}`],probeCommand=cmdPreview(auth.cmd,probeArgs);log(`channel=${channel} probe start endpoint=${c.host}:${c.port} attempt=${c.attempt||1} auth=${auth.name} transport=${c.transport||"(direct)"} proxy=${c.proxy||"(none)"} command=${probeCommand}`);
   const probe=await exec(auth.cmd,probeArgs,{timeout:30000,env:auth.env}),verified=probe.ok&&probe.out.trim()===source.nodeId,reason=probeFailure(probe,source);
   report.attempts.push({endpoint:`${c.host}:${c.port}`,attempt:c.attempt||1,auth:auth.name,transport:c.transport||"",proxy:c.proxy||"",command:probeCommand,verified,durationMs:probe.durationMs,status:probe.status,error:reason||undefined});
   log(`channel=${channel} probe done endpoint=${c.host}:${c.port} auth=${auth.name} ok=${probe.ok} verified=${verified} reason=${reason||"(none)"} durationMs=${probe.durationMs}`);
   if(!verified)continue;
   report.endpoint=`${c.host}:${c.port}`;report.auth=auth.name;report.transport=c.transport||"";report.paths=[];
   for(const raw of cfg.sync_paths){
    const rel=safePath(raw),local=smoke?resolve(ws,"ci-runtime/smoke-sync-results",channel):resolve(ws,rel),remote=String(source.ssh.workspace||ws).replace(/\/$/,"");mkdirSync(local,{recursive:true});
    const remoteShell=[...(auth.name==="password"?["sshpass","-e"]:[]),"ssh",...args].map(quote).join(" ");
    const rsyncArgs=[...cfg.rsync_options,"-e",remoteShell,`${target}:${remote}/${posix.normalize(rel)}/`,`${local}/`],rsyncCommand=cmdPreview("rsync",rsyncArgs);log(`channel=${channel} rsync start path=${rel} remote=${target}:${remote}/${posix.normalize(rel)}/ local=${local}/ command=${rsyncCommand}`);
    const r=await exec("rsync",rsyncArgs,{timeout:(cfg.sync_timeout_seconds||600)*1000,env:auth.env});
    if(!r.ok){report.paths.push({path:rel,destination:relative(ws,local),command:rsyncCommand,durationMs:r.durationMs,status:r.status,error:r.err});warn(`channel=${channel} rsync failed path=${rel} status=${r.status??"n/a"} durationMs=${r.durationMs} stderr=${r.err||"(none)"}`);throw new Error(`rsync ${rel}: ${r.err}`)}
    const inv=inventory(local),verification=smoke?verifySmoke(local):{};report.paths.push({path:rel,destination:relative(ws,local),command:rsyncCommand,durationMs:r.durationMs,...inv,...verification});log(`channel=${channel} auth=${auth.name} path=${rel} files=${inv.files.length} dirs=${inv.dirs.length} checksum=${inv.checksum} verified=${verification.checksumVerified??"n/a"} durationMs=${r.durationMs}`);
   }
   report.status="passed";break outer;
  }}
  if(report.status!=="passed")throw new Error(`all endpoints/auth modes rejected attempts=${JSON.stringify(report.attempts.map(({endpoint,attempt,auth,transport,verified,durationMs,status,error})=>({endpoint,attempt,auth,transport,verified,durationMs,status,error})))}`);
 }catch(e){report.error=e.message;warn(`channel=${channel} failed: ${e.message}`)}finally{report.finishedAt=new Date().toISOString();report.durationMs=Date.now()-begin;mkdirSync(reports,{recursive:true});writeFileSync(resolve(reports,`${channel}.json`),JSON.stringify(report,null,2)+"\n");log(`channel-report channel=${channel} status=${report.status} started=${startedAt} finished=${report.finishedAt} durationMs=${report.durationMs}`)}return report;
}
// Cờ GATE cho orchestrator: chỉ khi file này tồn tại + nội dung "ok" thì node
// mới được phép GIÀNH leader. Đảm bảo yêu cầu: "runner sau lấy dữ liệu của
// leader về bằng rsync XONG mới giành làm leader."
const syncGateFile=resolve(ws,"ci-runtime/nodesync/sync-ok");
function writeGate(status,detail){try{mkdirSync(dirname(syncGateFile),{recursive:true});writeFileSync(syncGateFile,JSON.stringify({status,detail,at:new Date().toISOString()})+"\n")}catch(e){warn(`writeGate failed: ${e.message}`)}}
async function main(){
 log("=== SSH predecessor sync ===");
 if(!cfg.sync_paths.length){log("SSH_SYNC_PATHS empty; skip");writeGate("ok","no-sync-paths");return}
 if(!existsSync(predecessorFile))throw new Error(`missing discovery manifest ${predecessorFile}`);
 ensureAuthFiles();
 const{source,selfId}=JSON.parse(readFileSync(predecessorFile,"utf8"));
 if(!source){log(`runner=${selfId} first runner; smoke source data retained for successor`);writeGate("ok","first-runner");return}
 const channels=enabledChannels(cfg);
 // Tailscale-SSH KHÔNG cần key/password (Tailscale tự auth). Chỉ bắt buộc có
 // key/password khi KHÔNG có kênh nào dùng Tailscale-SSH.
 const tsSshPossible=channels.includes("tailscale")&&source.tailscale?.available&&source.tailscale?.online&&source.tailscale?.ssh===true;
 if(!existsSync(keyFile)&&!authPass&&!tsSshPossible)throw new Error("missing SSH key and password (and predecessor has no Tailscale SSH)");
 let results;
 if(smoke)results=await Promise.all(channels.map(c=>syncChannel(c,source,selfId)));
 else{results=[];for(const c of channels){const r=await syncChannel(c,source,selfId);results.push(r);if(r.status==="passed")break}}
 const summary={smoke,source:source.nodeId,current:selfId,generatedAt:new Date().toISOString(),results:results.map(({channel,status,transport,durationMs,error})=>({channel,status,transport,durationMs,error}))};
 writeFileSync(resolve(reports,"summary.json"),JSON.stringify(summary,null,2)+"\n");
 if(!results.some(r=>r.status==="passed")){writeGate("failed","no-channel-passed");throw new Error("no SSH channel passed")}
 const passed=results.find(r=>r.status==="passed");
 writeGate("ok",`channel=${passed.channel} transport=${passed.transport||"direct"}`);
 log(`SSH SYNC PASS ${results.map(r=>`${r.channel}:${r.status}`).join(" ")}`)
}
main().catch(e=>{error(e.stack||e.message);process.exit(1)});
