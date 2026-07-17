#!/usr/bin/env node
// Non-interactive Linux SSH user provisioning for CI runners and local hosts.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectSshUsers, nodesyncEnabled } from "./lib/env.mjs";
import { log, warn, error } from "./lib/log.mjs";
import { parseEnv } from "../../scripts/lib/env-utils.mjs";
const args=process.argv.slice(2),dry=args.includes("--dry-run"),envIdx=args.indexOf("--env"),envFile=envIdx>=0?resolve(args[envIdx+1]):resolve(".env");
const env={...(existsSync(envFile)?parseEnv(envFile):{}),...process.env};
function run(cmd,argv,{input,timeout=20000}={}){const shown=/(chpasswd)/.test(cmd)?`${cmd} <hidden>`:`${cmd} ${argv.join(" ")}`;log(`${dry?"[DRY RUN] ":""}${shown}`);if(dry)return{ok:true,out:"",err:""};const r=spawnSync(cmd,argv,{encoding:"utf8",input,timeout});return{ok:r.status===0,out:(r.stdout||"").trim(),err:(r.stderr||r.error?.message||"").trim()}}
const root=()=>process.getuid?.()===0;
function privileged(cmd,argv,opt){return root()?run(cmd,argv,opt):run("sudo",["-n",cmd,...argv],opt)}
const exists=(u)=>!dry&&spawnSync("id",[u]).status===0;
function create(u){
 if(!/^[a-z_][a-z0-9_-]*[$]?$/i.test(u.user))throw new Error(`SSH user invalid: ${u.user}`);
 log(`provision user=${u.user} index=${u.index} privileged=${u.privileged}`);
 if(!exists(u.user)){const a=["--no-log-init","-m","-s",u.shell];if(u.uid)a.push("-u",String(u.uid));a.push(u.user);let r=privileged("useradd",a);if(!r.ok){warn(`useradd failed, fallback adduser: ${r.err}`);const b=["--disabled-password","--gecos","",...(u.uid?["--uid",String(u.uid)]:[]),"--shell",u.shell,u.user];r=privileged("adduser",b);if(!r.ok)throw new Error(r.err)}}
 if(u.password){const r=privileged("chpasswd",[],{input:`${u.user}:${u.password}\n`});if(!r.ok)throw new Error(`chpasswd ${u.user}: ${r.err}`);log(`password configured user=${u.user} value=<hidden>`)}
 const home=spawnSync("getent",["passwd",u.user],{encoding:"utf8"}).stdout?.trim().split(":")[5]||`/home/${u.user}`,ssh=`${home}/.ssh`;
 privileged("mkdir",["-p",ssh]);privileged("chmod",["700",ssh]);
 if(u.publicKey){const tmp=resolve(`ci-runtime/nodesync/authorized-${u.index}`);if(!dry){mkdirSync(resolve("ci-runtime/nodesync"),{recursive:true});writeFileSync(tmp,u.publicKey.trim()+"\n",{mode:0o600})}privileged("cp",[tmp,`${ssh}/authorized_keys`]);privileged("chmod",["600",`${ssh}/authorized_keys`])}
 if(u.privateKey){const tmp=resolve(`ci-runtime/nodesync/key-${u.index}`);if(!dry)writeFileSync(tmp,u.privateKey.trim()+"\n",{mode:0o600});privileged("cp",[tmp,`${ssh}/id_ed25519`]);privileged("chmod",["600",`${ssh}/id_ed25519`])}
 privileged("chown",["-R",`${u.user}:${u.user}`,ssh]);
 if(u.privileged){const group=spawnSync("getent",["group","sudo"]).status===0?"sudo":"wheel";privileged("usermod",["-aG",group,u.user]);const tmp=resolve(`ci-runtime/nodesync/sudoers-${u.index}`);if(!dry)writeFileSync(tmp,`${u.user} ALL=(ALL) NOPASSWD:ALL\n`,{mode:0o440});privileged("install",["-m","0440",tmp,`/etc/sudoers.d/nodesync-${u.user}`]);log(`sudo NOPASSWD configured user=${u.user}`)}
 return u.user;
}
try{
 if(process.platform!=="linux")throw new Error("SSH user provisioning currently requires Linux");
 if(!nodesyncEnabled(env)){log("SSH_ENABLE!=1; skip users");process.exit(0)}
 const users=collectSshUsers(env);if(!users.length)throw new Error("No SSH_<index>_USER configured; run ssh-setup-env first");
 const done=users.map(create);log(`users ready count=${done.length} names=${done.join(",")}`);
}catch(e){error(e.stack||e.message);process.exit(1)}
