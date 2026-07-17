// nodesync/scripts/lib/transports.mjs
// Pure endpoint construction for predecessor sync. Keep network-namespace
// decisions here so they can be unit tested without Docker or a live tailnet.

const TAILSCALE_SOCKS_PROXY = "nc -x tailscale:1055 %h %p";

function clean(value) {
  return typeof value === "string" ? value.trim().replace(/\.$/, "") : "";
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function isIpv4(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

export function tailscaleHosts(source) {
  const ts = source.tailscale || {};
  const dns = clean(ts.dnsName);
  const ips = unique([ts.ip, ...(ts.ips || [])]);
  // Prefer the advertised primary IP, then IPv4, then IPv6. MagicDNS remains
  // the first attempt, but every address is sent through the Tailscale
  // userspace SOCKS5 sidecar; none is a direct/hybrid route.
  const orderedIps = [
    ...ips.filter((ip) => ip === clean(ts.ip)),
    ...ips.filter((ip) => ip !== clean(ts.ip) && isIpv4(ip)),
    ...ips.filter((ip) => ip !== clean(ts.ip) && !isIpv4(ip)),
  ];
  return unique([dns, ...orderedIps]);
}

export function endpoints(source, { cloudflareAttempts = 1 } = {}) {
  const map = { tailscale: [], cloudflare: [], hybrid: [] };

  if (source.tailscale?.available && source.tailscale?.online) {
    for (const host of tailscaleHosts(source)) {
      map.tailscale.push({
        host,
        port: source.ssh?.tailscalePort || 2222,
        proxy: TAILSCALE_SOCKS_PROXY,
        transport: "ts-serve",
        address: host === clean(source.tailscale?.dnsName) ? "magicdns" : "tailnet-ip",
      });
    }
  }

  // sync.mjs runs inside nodesync. cloudflared here is the local Access client,
  // not the connector service, which intentionally starts only after sync.
  if (source.domain) {
    for (let attempt = 1; attempt <= cloudflareAttempts; attempt += 1) {
      map.cloudflare.push({
        host: `ssh.${source.domain}`,
        port: 22,
        attempt,
        proxy: "cloudflared access ssh --hostname %h",
        transport: "cloudflare-access-client",
      });
    }
  }

  // Hybrid is direct host/LAN routing. Tailnet CGNAT addresses are excluded
  // because they only work through the Tailscale userspace SOCKS5 sidecar.
  for (const host of source.ssh?.ips || []) {
    if (!host || typeof host !== "string") continue;
    if (/^fe80:/i.test(host)) continue;
    if (/^(127\.|::1$|169\.254\.)/.test(host)) continue;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) continue;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) continue;
    if (/^10\./.test(host) && !["1", "true", "yes", "on"].includes(String(process.env.SSH_HYBRID_ALLOW_10 || "0").toLowerCase())) continue;
    map.hybrid.push({ host, port: source.ssh?.port || 22 });
  }

  return map;
}

export function isProxyBootstrapFailure(stderr = "") {
  return /(?:cloudflared|nc): (?:not found|command not found)|exec: .*cloudflared.*not found|No such container/i.test(stderr);
}
