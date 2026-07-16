#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const ROOT=resolve(process.cwd(),"../..");
const text=(p)=>readFileSync(resolve(ROOT,p),"utf8");
const requirePattern=(p,re,msg)=>{if(!re.test(text(p)))throw new Error(`${p}: ${msg}`)};
const forbid=(p,re,msg)=>{if(re.test(text(p)))throw new Error(`${p}: ${msg}`)};
requirePattern("orchestrator/Dockerfile",/FROM node:24-alpine3\.23/,"orchestrator phải dùng Node 24");
requirePattern("scripts/runners/setup-env.mjs",/WHOAMI_NAME=\$\{nodeId\}/,"identity whoami phải tự materialize");
requirePattern("scripts/runners/start-stack.mjs",/setup-nodesync-ssh[\s\S]*discover-predecessor[\s\S]*scripts\/sync\.mjs/,"startup dynamic sync wiring thiếu");
requirePattern("nodesync/scripts/sync.mjs",/StrictHostKeyChecking=yes[\s\S]*identity\.out\.trim\(\)===source\.nodeId/,"phải pin host key + verify node id");
requirePattern("nodesync/scripts/sync.mjs",/tailscale:1055[\s\S]*cloudflared access ssh[\s\S]*hybrid/,"fallback transports thiếu");
for(const p of ["caddy/caddy.yml","whoami/whoami.yml","filebrowser/filebrowser.yml","dozzle/dozzle.yml","webssh/webssh.yml","docker-compose.ci.yml","scripts/addapp/add-app.mjs"]) forbid(p,/nodesync_hold_gate|nodesync:8088|@nodesync_enabled/,"còn wiring hold gate cũ");
forbid("nodesync/Dockerfile",/openssh-server|FROM cloudflare\/cloudflared/,"nodesync không được nhúng SSH server/cloudflared");
console.log("VERIFY-SOURCE-INVARIANTS: PASS ✅");
