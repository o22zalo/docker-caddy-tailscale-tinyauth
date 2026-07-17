#!/usr/bin/env node
// Chọn runner sống đã lên trước current node; không phụ thuộc tên node01/node02.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const PREDECESSOR_FILE = "/workspace/ci-runtime/nodesync/predecessor.json";
export function predecessorCandidates(nodes, selfId, now=Date.now(), ttl=90000) {
  const self=nodes[selfId]; if(!self) return null;
  return Object.entries(nodes)
    .map(([id,n])=>({id,node:n,ageMs:now-(n.heartbeat||0),gapMs:(self.startedAt||Infinity)-(n.startedAt||0),beforeSelf:(n.startedAt||0)<(self.startedAt||Infinity),stateOk:["ready","serving","draining"].includes(n.state),sshOk:!!n.ssh?.available,sshNodeOk:!n.ssh?.nodeId||n.ssh.nodeId===id}))
    .filter((x)=>x.id!==selfId && x.beforeSelf && x.stateOk && x.ageMs<=ttl && x.sshOk && x.sshNodeOk)
    .sort((a,b)=>(b.node.startedAt||0)-(a.node.startedAt||0));
}
export function selectPredecessor(nodes, selfId, now=Date.now(), ttl=90000) {
  const candidates=predecessorCandidates(nodes,selfId,now,ttl);
  if(!candidates)return null;
  return candidates.length ? { nodeId:candidates[0].id, ...candidates[0].node } : null;
}
async function main(){
  const args=process.argv.slice(2);
  if(args.includes("--path")){console.log(PREDECESSOR_FILE);return}
  const json = args.includes("--json");
  if(json) console.log = (...a) => console.error(...a);
  const [{ connectRtdb }, { getNodeIdentity, heartbeatTtlMs }] = await Promise.all([
    import("./lib/rtdb.mjs"),
    import("./lib/node-identity.mjs"),
  ]);
  const {db,paths}=connectRtdb(); const self=getNodeIdentity().nodeId;
  const nodes=(await db.ref(paths.nodes).get()).val()||{};
  const ttl=heartbeatTtlMs(), now=Date.now(), candidates=predecessorCandidates(nodes,self,now,ttl)||[];
  const source=candidates.length ? { nodeId:candidates[0].id, ...candidates[0].node } : null;
  const output={version:1,selfId:self,source,discoveredAt:new Date().toISOString(),ttlMs:ttl,candidates:candidates.map(({id,node,ageMs,gapMs})=>({id,state:node.state,ageMs,gapMs,startedAt:node.startedAt,sshNodeId:node.ssh?.nodeId||"",tailscaleIp:node.tailscale?.ip||"",domain:node.domain||""}))};
  if(json){process.stdout.write(JSON.stringify(output,null,2)+"\n");process.exit(0)}
  console.error(source?`[nodesync-discovery] source=${source.nodeId} startedAt=${source.startedAt}`:"[nodesync-discovery] no predecessor; first runner skips sync");
}
if(resolve(process.argv[1]||"")===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e);process.exit(1)});
