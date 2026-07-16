import { existsSync, readFileSync } from "node:fs";
const FILE = process.env.ORCH_HOST_SSH_MANIFEST || "/workspace/ci-runtime/nodesync/host-ssh.json";
export function getHostSshInfo() {
  if (!existsSync(FILE)) return { available:false, reason:`manifest not found: ${FILE}` };
  try {
    const x=JSON.parse(readFileSync(FILE,"utf8"));
    if (!x.nodeId || !x.user || !x.hostKey) throw new Error("thiếu nodeId/user/hostKey");
    return { available:true, ...x, privateKey:undefined };
  } catch(e) { return { available:false, reason:e.message }; }
}
