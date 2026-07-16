#!/usr/bin/env node
// Chọn runner sống đã lên trước current node; không phụ thuộc tên node01/node02.
import { writeFileSync } from "node:fs";
import { connectRtdb } from "./lib/rtdb.mjs";
import { getNodeIdentity, heartbeatTtlMs } from "./lib/node-identity.mjs";
export function selectPredecessor(nodes, selfId, now=Date.now(), ttl=90000) {
  const self=nodes[selfId]; if(!self) return null;
  const candidates=Object.entries(nodes)
    .filter(([id,n])=>id!==selfId && (n.startedAt||0)<(self.startedAt||Infinity))
    .filter(([,n])=>["ready","serving","draining"].includes(n.state) && now-(n.heartbeat||0)<=ttl)
    .filter(([,n])=>n.ssh?.available)
    .sort((a,b)=>{
      const leaderBias=(x)=>x.state==="serving"?1:0;
      return leaderBias(b[1])-leaderBias(a[1]) || (b[1].startedAt||0)-(a[1].startedAt||0);
    });
  return candidates.length ? { nodeId:candidates[0][0], ...candidates[0][1] } : null;
}
async function main(){
  const {db,paths}=connectRtdb(); const self=getNodeIdentity().nodeId;
  const nodes=(await db.ref(paths.nodes).get()).val()||{};
  const source=selectPredecessor(nodes,self,Date.now(),heartbeatTtlMs());
  const output={version:1,selfId:self,source,discoveredAt:new Date().toISOString()};
  const out=process.env.NODESYNC_PREDECESSOR_FILE||"/workspace/ci-runtime/nodesync/predecessor.json";
  writeFileSync(out,JSON.stringify(output,null,2)+"\n");
  console.log(source?`[nodesync-discovery] source=${source.nodeId} startedAt=${source.startedAt}`:"[nodesync-discovery] no predecessor; first runner skips sync");
}
if(import.meta.url===`file://${process.argv[1]}`) main().catch(e=>{console.error(e);process.exit(1)});
