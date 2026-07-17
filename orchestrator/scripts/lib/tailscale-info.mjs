// orchestrator/scripts/lib/tailscale-info.mjs
// Thu thập thông tin node Tailscale (tailnet) để bổ sung vào node record RTDB.
//
// YÊU CẦU (Phần 1): "Thông tin của các node, bổ sung thêm thông tin của mạng
// tailscale như: ip, hostname, version, os..."
//
// CÁCH LẤY (đúng tài liệu Tailscale — userspace + --accept-dns=false):
//   - KHÔNG dựa vào system DNS (/etc/resolv.conf) vì stack set --accept-dns=false.
//   - Dùng LocalAPI qua CLI `tailscale status --json` (chạy trong container
//     tailscale qua `docker compose exec`), rồi đọc field Self.
//   - `tailscale version` cho phiên bản client.
//   Docs: https://tailscale.com/docs/reference/quad100
//         https://tailscale.com/docs/concepts/userspace-networking
//
// An toàn: mọi lệnh best-effort, lỗi/không có tailscale → trả object rỗng +
// lý do (reason) để log/debug rõ ràng "vì sao không lấy được" (yêu cầu về
// debug khi thiếu môi trường).

import { spawnSync } from "node:child_process";
import { REPO_DIR } from "./docker.mjs";

// Service tailscale trong compose (mặc định "tailscale"). Cho phép override.
function tsService() {
  return process.env.ORCH_TS_SERVICE || "tailscale";
}

// Chạy 1 lệnh trong container tailscale qua compose exec. Trả { ok, out, err }.
function tsExec(cmdArgs, { timeout = 15_000 } = {}) {
  const project = process.env.COMPOSE_PROJECT_NAME;
  const files = (process.env.ORCH_COMPOSE_FILES || "docker-compose.yml")
    .split(",").map((f) => f.trim()).filter(Boolean)
    .flatMap((f) => ["-f", f]);
  const argv = [
    "compose",
    ...(project ? ["-p", project] : []),
    ...files,
    "exec", "-T", tsService(),
    ...cmdArgs,
  ];
  const res = spawnSync("docker", argv, {
    cwd: REPO_DIR, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    out: (res.stdout || "").toString().trim(),
    err: (res.stderr || res.error?.message || "").toString().trim(),
  };
}

// Parse an toàn JSON.
function tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Lấy thông tin tailnet của node hiện tại.
 * Trả về:
 *   {
 *     available: boolean,          // có lấy được từ tailscale không
 *     reason: string|null,         // lý do nếu không lấy được (để debug)
 *     ip: string,                  // tailnet IPv4 (100.x.y.z)
 *     ips: string[],               // toàn bộ tailnet IPs
 *     hostname: string,            // HostName trên tailnet
 *     dnsName: string,             // FQDN MagicDNS (....ts.net)
 *     os: string,                  // OS report bởi tailscale
 *     version: string,             // phiên bản client tailscale
 *     tailnet: string,             // domain tailnet (....ts.net) nếu suy ra được
 *     online: boolean,             // Self.Online
 *     tags: string[],              // ACL tags
 *   }
 */
export function getTailscaleInfo() {
  const empty = {
    available: false, reason: null,
    ip: "", ips: [], hostname: "", dnsName: "",
    os: "", version: "", tailnet: "", online: false, tags: [], ssh: false,
  };

  // Bật/tắt thu thập (mặc định bật nếu profile có tailscale — nhưng best-effort).
  if (String(process.env.ORCH_TS_INFO_ENABLE ?? "1").toLowerCase() === "0") {
    return { ...empty, reason: "disabled via ORCH_TS_INFO_ENABLE=0" };
  }

  const status = tsExec(["tailscale", "status", "--json"]);
  if (!status.ok || !status.out) {
    return {
      ...empty,
      reason: `tailscale status --json failed: ${status.err || "no output"} (tailnet có thể chưa join / thiếu authkey / service tailscale không chạy)`,
    };
  }

  const j = tryJson(status.out);
  if (!j || !j.Self) {
    return { ...empty, reason: "cannot parse tailscale status JSON (no Self)" };
  }

  const self = j.Self;
  const dnsName = (self.DNSName || "").replace(/\.$/, ""); // bỏ dấu chấm cuối FQDN
  // tailnet = phần sau hostname trong FQDN: host.tailnet.ts.net → tailnet.ts.net
  let tailnet = j.MagicDNSSuffix || "";
  if (!tailnet && dnsName.includes(".")) tailnet = dnsName.slice(dnsName.indexOf(".") + 1);

  // Version: ưu tiên từ status JSON (Version), fallback `tailscale version`.
  let version = j.Version || "";
  if (!version) {
    const v = tsExec(["tailscale", "version"]);
    if (v.ok) version = v.out.split(/\r?\n/)[0] || "";
  }

  // Node này có bật Tailscale SSH không?
  //   - `tailscale up --ssh` → node xuất hiện SSH host keys + capability
  //     "https://tailscale.com/cap/ssh". Dùng để nodesync quyết định có dùng
  //     Tailscale SSH trực tiếp hay fallback serve+proxy.
  //   Docs: https://tailscale.com/docs/features/tailscale-ssh
  const caps = self.Capabilities || self.CapMap ? Object.keys(self.CapMap || {}).concat(self.Capabilities || []) : [];
  const sshEnabled =
    Array.isArray(self.sshHostKeys) && self.sshHostKeys.length > 0
      ? true
      : caps.some((c) => String(c).includes("cap/ssh"));

  return {
    available: true,
    reason: null,
    ip: (self.TailscaleIPs || []).find((x) => x.includes(".")) || (self.TailscaleIPs || [])[0] || "",
    ips: self.TailscaleIPs || [],
    hostname: self.HostName || "",
    dnsName,
    os: self.OS || j.OS || "",
    version,
    tailnet,
    online: !!self.Online,
    tags: self.Tags || [],
    // SSH của Tailscale (để nodesync ưu tiên đường Tailscale SSH khi có).
    ssh: sshEnabled,
  };
}
