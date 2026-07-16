// nodesync/scripts/lib/ssh.mjs
// Resolve + kết nối SSH qua Tailscale (userspace SOCKS5), Cloudflare Access,
// hoặc host trực tiếp. Kênh chỉ được chọn sau khi SSH probe thành công.

import { spawnSync } from "node:child_process";
import { log, warn, error } from "./log.mjs";

export function run(cmd, args, { timeout = 15000, input, env } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout,
    input,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    out: (res.stdout || "").toString().trim(),
    err: (res.stderr || res.error?.message || "").toString().trim(),
  };
}

function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }
function safeHost(value) {
  return /^[a-zA-Z0-9._:-]+$/.test(String(value || ""));
}

function tailscaleExec(args, timeout = 12000) {
  // tailscaled chạy trong sidecar riêng; nodesync có docker.sock để gọi LocalAPI
  // qua CLI nằm trong container tailscale.
  return run("docker", ["exec", "tailscale", "tailscale", ...args], { timeout });
}

export function resolveTailscale(peer) {
  const want = (peer.tailscaleHost || "").replace(/\.$/, "").toLowerCase();
  if (!want || !safeHost(want)) {
    return { channel: "tailscale", host: null, reason: "NODESYNC_PEER_TAILSCALE_HOST trống hoặc không hợp lệ" };
  }

  const status = tailscaleExec(["status", "--json"]);
  if (!status.ok || !status.out) {
    return {
      channel: "tailscale", host: null,
      reason: `docker exec tailscale tailscale status --json thất bại: ${status.err || "no output"}`,
    };
  }

  const json = tryJson(status.out);
  for (const p of Object.values(json?.Peer || {})) {
    const host = String(p.HostName || "").toLowerCase();
    const dns = String(p.DNSName || "").replace(/\.$/, "").toLowerCase();
    if (host === want || dns === want || dns.startsWith(`${want}.`)) {
      const ip = (p.TailscaleIPs || []).find((x) => x.includes(".")) || (p.TailscaleIPs || [])[0];
      if (ip) {
        return {
          channel: "tailscale", host: ip, method: "status-json+socks5",
          proxyCommand: "nc -x tailscale:1055 %h %p",
          reason: null,
        };
      }
    }
  }

  return { channel: "tailscale", host: null, reason: `không thấy peer "${want}" trong tailscale status` };
}

export function resolveCloudflare(peer) {
  if (!peer.cloudflareHost || !safeHost(peer.cloudflareHost)) {
    return { channel: "cloudflare", host: null, reason: "NODESYNC_PEER_CLOUDFLARE_HOST trống hoặc không hợp lệ" };
  }
  const has = run("sh", ["-lc", "command -v cloudflared"], { timeout: 8000 });
  if (!has.ok) return { channel: "cloudflare", host: null, reason: "không tìm thấy binary cloudflared" };
  return {
    channel: "cloudflare",
    host: peer.cloudflareHost,
    proxyCommand: `cloudflared access ssh --hostname ${peer.cloudflareHost}`,
    reason: null,
  };
}

export function resolveHybrid(peer) {
  if (!peer.directHost || !safeHost(peer.directHost)) {
    return { channel: "hybrid", host: null, reason: "NODESYNC_PEER_HOST trống hoặc không hợp lệ" };
  }
  return { channel: "hybrid", host: peer.directHost, reason: null };
}

export function resolveChannel(channel, peer) {
  if (channel === "tailscale") return resolveTailscale(peer);
  if (channel === "cloudflare") return resolveCloudflare(peer);
  if (channel === "hybrid") return resolveHybrid(peer);
  return { channel, host: null, reason: "kênh không hỗ trợ" };
}

// Giữ API cũ cho resolve-peer CLI. Lưu ý: hàm này chỉ resolve; sync.mjs còn
// probe SSH và fallback tiếp nếu transport/authentication thất bại.
export function resolvePeer(channels, peer) {
  const attempts = [];
  for (const channel of channels) {
    const resolved = resolveChannel(channel, peer);
    attempts.push(resolved);
    if (resolved.host) {
      log(`Resolve peer OK qua kênh "${channel}" → ${resolved.host}${resolved.method ? ` (method=${resolved.method})` : ""}`);
      return { resolved, attempts };
    }
    warn(`Kênh "${channel}" không resolve được → fallback. Lý do: ${resolved.reason}`);
  }
  error("Tất cả kênh đều thất bại — không resolve được peer.");
  return { resolved: null, attempts };
}

export function sshBaseArgs(resolved, { port = 22, connectTimeout = 10, identityFile, batchMode = true } = {}) {
  const args = [
    "-o", `BatchMode=${batchMode ? "yes" : "no"}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=/etc/ssh/ssh_known_hosts",
    "-o", `ConnectTimeout=${connectTimeout}`,
    "-o", "LogLevel=ERROR",
    "-p", String(port),
  ];
  if (identityFile) args.push("-i", identityFile, "-o", "IdentitiesOnly=yes");
  if (resolved?.proxyCommand) args.push("-o", `ProxyCommand=${resolved.proxyCommand}`);
  return args;
}

export function sshCommand(auth, sshArgs, target, remoteCommand, timeout = 15000) {
  const argv = [...sshArgs, target, remoteCommand];
  if (auth?.password) {
    return run("sshpass", ["-e", "ssh", ...sshArgs, target, remoteCommand], {
      timeout,
      env: { SSHPASS: auth.password },
    });
  }
  return run("ssh", argv, { timeout });
}
