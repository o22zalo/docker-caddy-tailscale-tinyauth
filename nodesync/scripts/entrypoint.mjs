#!/usr/bin/env node
// Nodesync client/controller sidecar. SSH server được bootstrap trên CI runner.
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig, nodesyncEnabled } from "./lib/env.mjs";
import { log, error } from "./lib/log.mjs";
async function main(){
  const cfg=loadConfig();
  log(`=== NODESYNC controller === enabled=${nodesyncEnabled()} syncPaths=${cfg.sync_paths.length}`);
  if (!nodesyncEnabled()) log("SSH_ENABLE!=1 → idle");
  else if (!cfg.sync_paths.length) log("Không có file/folder cấu hình để sync → idle, không SSH/rsync");
  while(true) await sleep(3600_000);
}
main().catch(e=>{error(e.stack||e.message);process.exit(1)});
