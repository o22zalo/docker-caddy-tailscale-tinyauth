#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "jsonc-parser";
import { selectPredecessor } from "../../orchestrator/scripts/discover-predecessor.mjs";
import { monitorLeaderWhoami, parseWhoamiName } from "../../orchestrator/scripts/lib/leader-whoami-monitor.mjs";
const ROOT=resolve(process.cwd(),"../..");
const text=(p)=>readFileSync(resolve(ROOT,p),"utf8");
const now=Date.now();
const nodes={
  "runner-z":{startedAt:100,heartbeat:now,state:"serving",ssh:{available:true}},
  "runner-a":{startedAt:200,heartbeat:now,state:"ready",ssh:{available:true}},
  "runner-old-dead":{startedAt:50,heartbeat:0,state:"serving",ssh:{available:true}},
};
assert.equal(selectPredecessor(nodes,"runner-a",now,90000).nodeId,"runner-z","phải chọn runner lên trước, không theo tên");
assert.equal(selectPredecessor({"first":{startedAt:100,heartbeat:now,state:"ready",ssh:{available:true}}},"first",now,90000),null);
const cfg=parse(text("nodesync/config.jsonc")); assert.deepEqual(cfg.sync_paths,[]);
assert.equal(parseWhoamiName("Name: runner-z\nIP: 1.2.3.4"),"runner-z");
let n=0; const logs=[];
const result=await monitorLeaderWhoami({getLeader:async()=>({nodeId:"runner-z"}),selfId:"runner-z",url:"https://test.invalid",intervalMs:1,timeoutMs:100,log:(x)=>logs.push(x),warn:(x)=>logs.push(x),fetchFn:async()=>({ok:true,status:200,text:async()=>`Name: ${++n===1?"old":"runner-z"}`})});
assert.equal(result.matched,true); assert.match(logs.join("\n"),/MISMATCH[\s\S]*MATCH/);
assert.match(text("cloudflare/scripts/hostnames.jsonc"),/"hostname": "ssh"[\s\S]*ssh:\/\/host\.docker\.internal:22/);
assert.doesNotMatch(text("caddy/caddy.yml"),/nodesync|SSH_ENABLE/);
for(const p of ["whoami/whoami.yml","filebrowser/filebrowser.yml","dozzle/dozzle.yml","webssh/webssh.yml","docker-compose.ci.yml"]) assert.doesNotMatch(text(p),/nodesync_hold_gate/);
console.log("VERIFY-NEW-ARCHITECTURE: PASS ✅");
