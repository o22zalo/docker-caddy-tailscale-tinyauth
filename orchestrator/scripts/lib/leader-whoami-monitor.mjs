// Quan sát traffic thực tế sau election; mismatch chỉ cảnh báo, không làm sidecar chết.
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
export function parseWhoamiName(body) { return String(body||"").match(/^Name:\s*(.+)$/mi)?.[1]?.trim() || ""; }
export async function monitorLeaderWhoami({ getLeader, selfId, url, log=console.log, warn=console.warn, fetchFn=fetch, intervalMs=5000, timeoutMs=120000 }) {
  if (!url) { warn("[leader-whoami] bỏ qua: chưa có ORCH_PUBLIC_URL/WHOAMI_HOST"); return {matched:false,reason:"no-url"}; }
  const end=Date.now()+timeoutMs; let attempt=0;
  while(Date.now()<end) {
    attempt++;
    const leader=await getLeader();
    if (leader?.nodeId!==selfId) return {matched:false,reason:"leader-changed"};
    try {
      const res=await fetchFn(url,{redirect:"follow",signal:AbortSignal.timeout(Math.min(8000,intervalMs))});
      const name=parseWhoamiName(await res.text());
      if (res.ok && name===leader.nodeId) { log(`[leader-whoami] MATCH attempt=${attempt} leader.nodeId=${leader.nodeId} whoami.Name=${name}`); return {matched:true,attempt}; }
      warn(`[leader-whoami] MISMATCH attempt=${attempt} status=${res.status} leader.nodeId=${leader.nodeId} whoami.Name=${name||"(missing)"}`);
    } catch(e) { warn(`[leader-whoami] WAIT attempt=${attempt} leader.nodeId=${leader.nodeId} error=${e.message}`); }
    await sleep(intervalMs);
  }
  warn(`[leader-whoami] TIMEOUT leader.nodeId=${selfId}; chỉ cảnh báo quan sát`);
  return {matched:false,reason:"timeout"};
}
