// tailscale/scripts/lib/publish-lib.mjs
// Pure helpers to publish stack apps over the tailnet in two independent ways.
// No side-effects (no fs, no exec) so every branch is unit-testable without
// Docker or a live tailnet — mirrors nodesync/scripts/lib/transports.mjs style.
//
// Hai cách publish app qua tailnet (bật/tắt độc lập qua env TS_PUBLISH_MODE):
//
//   Cách A — "serve"    : Tailscale Serve Web (schema serve.json Web{}).
//                         Proxy nội bộ chạy, NHƯNG không tạo MagicDNS record
//                         riêng cho từng subdomain. Có 2 kiểu:
//                           - subdomain: name.<tailnet>:443  (mỗi app 1 host ảo)
//                           - path     : <node>.<tailnet>:443/name (path-based)
//   Cách B — "services" : Tailscale Services (svc:<name>). Advertise qua CLI
//                         `tailscale serve --service=svc:<name> --https=443 up`.
//                         Tạo DNS name THẬT https://<name>.<tailnet>/ và cần
//                         autoApprovers.services trong ACL để tự duyệt.
//
// RÀNG BUỘC AN TOÀN (bất biến): mọi thứ ở đây CHỈ đụng tới Web{} / svc: scope.
// TCP{443 HTTPS, 2222 → host.docker.internal:22} là xương sống nodesync SSH
// sync và KHÔNG BAO GIỜ bị xoá/ghi đè bởi bất kỳ hàm nào trong file này.

/** SSH sync forward — invariant. Đừng đổi trừ khi nodesync đổi theo. */
export const SSH_FORWARD_PORT = 2222;
export const SSH_FORWARD_TARGET = "host.docker.internal:22";

export const PUBLISH_MODES = ["off", "serve", "services", "both"];
export const SERVE_STYLES = ["subdomain", "path"];
export const VIP_MODES = ["auto", "services", "skip"];

function truthy(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function trimDots(value) {
  return String(value || "").trim().replace(/^\.+|\.+$/g, "");
}

/** Chuẩn hoá & validate cấu hình publish từ env. Không throw — trả errors[]. */
export function resolvePublishConfig(env = {}) {
  const rawMode = String(env.TS_PUBLISH_MODE ?? "off").trim().toLowerCase();
  const mode = PUBLISH_MODES.includes(rawMode) ? rawMode : "off";

  const rawStyle = String(env.TS_SERVE_STYLE ?? "subdomain").trim().toLowerCase();
  const serveStyle = SERVE_STYLES.includes(rawStyle) ? rawStyle : "subdomain";

  const autoApprove = truthy(env.TS_SERVICES_AUTOAPPROVE, true);
  const tailnet = trimDots(env.TS_TAILNET);
  const nodeHost = trimDots(env.TS_HOSTNAME) || "proxy-stack";

  const rawVipMode = String(env.TS_SERVICES_VIP_MODE ?? "auto").trim().toLowerCase();
  const vipMode = VIP_MODES.includes(rawVipMode) ? rawVipMode : "auto";

  const warnings = [];
  if (rawMode && !PUBLISH_MODES.includes(rawMode)) {
    warnings.push(`TS_PUBLISH_MODE="${rawMode}" không hợp lệ → dùng "off". Hợp lệ: ${PUBLISH_MODES.join(", ")}.`);
  }
  if (rawStyle && !SERVE_STYLES.includes(rawStyle)) {
    warnings.push(`TS_SERVE_STYLE="${rawStyle}" không hợp lệ → dùng "subdomain". Hợp lệ: ${SERVE_STYLES.join(", ")}.`);
  }
  if (rawVipMode && !VIP_MODES.includes(rawVipMode)) {
    warnings.push(`TS_SERVICES_VIP_MODE="${rawVipMode}" không hợp lệ → dùng "auto". Hợp lệ: ${VIP_MODES.join(", ")}.`);
  }

  return {
    mode,
    serveStyle,
    autoApprove,
    tailnet,
    nodeHost,
    vipMode,
    doServe: mode === "serve" || mode === "both",
    doServices: mode === "services" || mode === "both",
    warnings,
  };
}

/** Danh sách tên (name + aliases) đã lọc trùng của 1 service entry. */
export function serviceNames(svc) {
  const all = [svc?.name, ...(svc?.names || [])].filter(Boolean);
  return [...new Set(all)];
}

function validServices(services) {
  return (services || []).filter((s) => s?.name && s?.upstream);
}

/**
 * Cách A — build object serve.json.
 * LUÔN kèm TCP 443 (HTTPS) + 2222 (SSH forward). Web{} chỉ thêm khi doServe.
 *   - style "subdomain": key = "<name>.<tailnet>:443"
 *   - style "path"     : key = "<node>.<tailnet>:443", Handlers gộp theo path
 */
export function buildServeConfig(services, cfg) {
  const tcp = {
    443: { HTTPS: true },
    [SSH_FORWARD_PORT]: { TCPForward: SSH_FORWARD_TARGET },
  };

  const web = {};
  if (cfg.doServe) {
    const tailnet = cfg.tailnet || "example.ts.net";
    const list = validServices(services);
    if (cfg.serveStyle === "path") {
      const hostKey = `${cfg.nodeHost}.${tailnet}:443`;
      const handlers = {};
      for (const svc of list) {
        for (const name of serviceNames(svc)) {
          handlers[`/${name}`] = { Proxy: svc.upstream };
        }
      }
      if (Object.keys(handlers).length) web[hostKey] = { Handlers: handlers };
    } else {
      for (const svc of list) {
        for (const name of serviceNames(svc)) {
          web[`${name}.${tailnet}:443`] = { Handlers: { "/": { Proxy: svc.upstream } } };
        }
      }
    }
  }

  return { TCP: tcp, Web: web };
}

/**
 * Cách B — build danh sách lệnh advertise (mảng argv, chưa kèm docker/exec).
 * Mỗi service → `tailscale serve --service=svc:<name> --https=443 <upstream>`.
 * KHÔNG đụng port 2222. Trả [] khi không bật services.
 */
export function buildAdvertiseCommands(services, cfg) {
  if (!cfg.doServices) return [];
  const cmds = [];
  for (const svc of validServices(services)) {
    // service name lấy theo `name` chính (aliases không tạo service riêng để
    // tránh trùng VIPService; alias là khái niệm của Serve Web, không của svc:).
    cmds.push({
      service: `svc:${svc.name}`,
      upstream: svc.upstream,
      argv: ["serve", `--service=svc:${svc.name}`, "--https=443", svc.upstream],
    });
  }
  return cmds;
}

/**
 * Cách B — build body cho PUT /vip-services/svc:<name> (Tailscale API).
 * Tạo VIP service trên control plane. idempotent — PUT 200 nếu đã tồn tại.
 * ports: ["do-not-validate"] vì Caddy/Tailscale terminate TLS bên ngoài.
 *
 * @param {string} serviceName - tên service (vd "svc:auth")
 * @param {string[]} addrs - [IPv4, IPv6] từ tailscale status. Bắt buộc cho mode "auto".
 */
export function buildVipServiceBody(serviceName, addrs = []) {
  const body = { name: serviceName, ports: ["do-not-validate"] };
  if (addrs.length >= 2) {
    body.addrs = [addrs[0], addrs[1]];
  }
  return body;
}

/**
 * Cách C — build body cho PUT /services/svc:<name> (Tailscale API mới).
 * Không cần addrs — API tự gán VIP.
 * @param {string} serviceName - tên service (vd "svc:auth")
 */
export function buildServicesBody(serviceName) {
  return { name: serviceName };
}

/**
 * Extract TailscaleIPs [IPv4, IPv6] từ tailscale status --json output.
 * Trả [] nếu không parse được.
 */
export function extractAddrs(statusJson) {
  try {
    const st = typeof statusJson === "string" ? JSON.parse(statusJson) : statusJson;
    const ips = st?.Self?.TailscaleIPs;
    if (Array.isArray(ips) && ips.length >= 2) return [ips[0], ips[1]];
    if (Array.isArray(ips) && ips.length === 1) return [ips[0]];
    return [];
  } catch { return []; }
}

/**
 * Cách B — build path + body cho POST approve host.
 * Dùng sau khi advertise để approve node cho service, tránh "pending approval".
 */
export function buildServiceApprovalBody() {
  return { approved: true };
}

/**
 * Extract hostname từ tailscale status --json output.
 * Trả "" nếu không parse được (caller fallback về TS_HOSTNAME).
 */
export function extractHostname(statusJson) {
  try {
    const st = typeof statusJson === "string" ? JSON.parse(statusJson) : statusJson;
    return st?.Self?.HostName || "";
  } catch { return ""; }
}

/**
 * Cách B — merge autoApprovers.services vào ACL policy (immutably).
 * approvers mặc định = các tag host (vd tag:container) để node tự duyệt.
 * KHÔNG đụng grants/ssh/tagOwners. No-op khi !doServices hoặc !autoApprove.
 */
export function mergeServiceAutoApprovers(policy, services, cfg, approvers) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("ACL policy is not a JSON object.");
  }
  if (!cfg.doServices || !cfg.autoApprove) return { nextPolicy: policy, added: [] };

  const approverList = [...new Set((approvers || []).filter(Boolean))];
  if (!approverList.length) return { nextPolicy: policy, added: [] };

  const existing =
    policy.autoApprovers && typeof policy.autoApprovers === "object" && !Array.isArray(policy.autoApprovers)
      ? policy.autoApprovers
      : {};
  const existingServices =
    existing.services && typeof existing.services === "object" && !Array.isArray(existing.services)
      ? { ...existing.services }
      : {};

  const added = [];
  for (const svc of validServices(services)) {
    const key = `svc:${svc.name}`;
    const prev = Array.isArray(existingServices[key]) ? existingServices[key] : [];
    const merged = [...new Set([...prev, ...approverList])];
    if (merged.length !== prev.length || !prev.length) added.push(key);
    existingServices[key] = merged;
  }

  if (!added.length && existing.services) return { nextPolicy: policy, added: [] };

  return {
    nextPolicy: {
      ...policy,
      autoApprovers: { ...existing, services: existingServices },
    },
    added,
  };
}
