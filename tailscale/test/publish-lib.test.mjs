import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAdvertiseCommands,
  buildServeConfig,
  buildServiceApprovalBody,
  buildVipServiceBody,
  buildServicesBody,
  extractAddrs,
  extractHostname,
  mergeServiceAutoApprovers,
  resolvePublishConfig,
  serviceNames,
  SSH_FORWARD_PORT,
  SSH_FORWARD_TARGET,
} from "../scripts/lib/publish-lib.mjs";

const SERVICES = [
  { name: "auth", upstream: "http://tinyauth:3000" },
  { name: "files", upstream: "http://filebrowser:80" },
  { name: "webssh", names: ["ttyd"], upstream: "http://webssh:7681" },
  { name: "dozzle", names: ["logs"], upstream: "http://dozzle:8080" },
  { name: "whoami", upstream: "http://whoami:80" },
];

const BASE_ENV = { TS_TAILNET: "tailaa8079.ts.net", TS_HOSTNAME: "proxy-stack-gh-1" };

// ── resolvePublishConfig ────────────────────────────────────────────────────
test("mode default is off; invalid values fall back with a warning", () => {
  const off = resolvePublishConfig({});
  assert.equal(off.mode, "off");
  assert.equal(off.doServe, false);
  assert.equal(off.doServices, false);

  const bad = resolvePublishConfig({ TS_PUBLISH_MODE: "wat", TS_SERVE_STYLE: "nope" });
  assert.equal(bad.mode, "off");
  assert.equal(bad.serveStyle, "subdomain");
  assert.ok(bad.warnings.length >= 2);
});

test("each mode toggles the right flags", () => {
  assert.deepEqual(pick(resolvePublishConfig({ TS_PUBLISH_MODE: "serve" })), { doServe: true, doServices: false });
  assert.deepEqual(pick(resolvePublishConfig({ TS_PUBLISH_MODE: "services" })), { doServe: false, doServices: true });
  assert.deepEqual(pick(resolvePublishConfig({ TS_PUBLISH_MODE: "both" })), { doServe: true, doServices: true });
  assert.deepEqual(pick(resolvePublishConfig({ TS_PUBLISH_MODE: "off" })), { doServe: false, doServices: false });
});

function pick(c) { return { doServe: c.doServe, doServices: c.doServices }; }

// ── INVARIANT: TCP 2222 (SSH sync) luôn còn trong MỌI mode ───────────────────
test("serve.json ALWAYS keeps TCP 443 + 2222 SSH forward in every mode", () => {
  for (const mode of ["off", "serve", "services", "both"]) {
    const cfg = resolvePublishConfig({ ...BASE_ENV, TS_PUBLISH_MODE: mode });
    const serve = buildServeConfig(SERVICES, cfg);
    assert.equal(serve.TCP[443].HTTPS, true, `mode=${mode} thiếu HTTPS 443`);
    assert.equal(serve.TCP[SSH_FORWARD_PORT].TCPForward, SSH_FORWARD_TARGET, `mode=${mode} thiếu SSH forward 2222`);
  }
});

// ── Cách A: serve.json Web{} ─────────────────────────────────────────────────
test("mode=off / services → Web{} rỗng (không publish subdomain)", () => {
  for (const mode of ["off", "services"]) {
    const cfg = resolvePublishConfig({ ...BASE_ENV, TS_PUBLISH_MODE: mode });
    assert.deepEqual(buildServeConfig(SERVICES, cfg).Web, {}, `mode=${mode} không được có Web host`);
  }
});

test("serve style=subdomain tạo host cho từng name + alias", () => {
  const cfg = resolvePublishConfig({ ...BASE_ENV, TS_PUBLISH_MODE: "serve", TS_SERVE_STYLE: "subdomain" });
  const web = buildServeConfig(SERVICES, cfg).Web;
  assert.ok(web["auth.tailaa8079.ts.net:443"]);
  assert.ok(web["ttyd.tailaa8079.ts.net:443"], "alias ttyd phải có host riêng");
  assert.ok(web["logs.tailaa8079.ts.net:443"], "alias logs phải có host riêng");
  assert.equal(web["whoami.tailaa8079.ts.net:443"].Handlers["/"].Proxy, "http://whoami:80");
});

test("serve style=path gộp tất cả app vào 1 host theo node, mỗi app 1 path", () => {
  const cfg = resolvePublishConfig({ ...BASE_ENV, TS_PUBLISH_MODE: "serve", TS_SERVE_STYLE: "path" });
  const web = buildServeConfig(SERVICES, cfg).Web;
  const hostKey = "proxy-stack-gh-1.tailaa8079.ts.net:443";
  assert.deepEqual(Object.keys(web), [hostKey], "chỉ 1 host duy nhất");
  const handlers = web[hostKey].Handlers;
  assert.equal(handlers["/auth"].Proxy, "http://tinyauth:3000");
  assert.equal(handlers["/ttyd"].Proxy, "http://webssh:7681");
  assert.equal(handlers["/logs"].Proxy, "http://dozzle:8080");
});

// ── Cách B: advertise commands ───────────────────────────────────────────────
test("advertise commands chỉ sinh khi services bật; không đụng 2222", () => {
  assert.deepEqual(buildAdvertiseCommands(SERVICES, resolvePublishConfig({ TS_PUBLISH_MODE: "off" })), []);
  assert.deepEqual(buildAdvertiseCommands(SERVICES, resolvePublishConfig({ TS_PUBLISH_MODE: "serve" })), []);

  const cmds = buildAdvertiseCommands(SERVICES, resolvePublishConfig({ TS_PUBLISH_MODE: "services" }));
  assert.equal(cmds.length, SERVICES.length);
  const whoami = cmds.find((c) => c.service === "svc:whoami");
  assert.deepEqual(whoami.argv, ["serve", "--service=svc:whoami", "--https=443", "http://whoami:80"]);
  // KHÔNG có lệnh nào chạm 2222 / clear.
  for (const c of cmds) {
    assert.ok(!c.argv.includes("clear"), "không được có 'clear'");
    assert.ok(!c.argv.join(" ").includes("2222"), "không được đụng port 2222");
    assert.ok(c.argv.join(" ").includes("--service=svc:"), "phải scope svc:");
  }
});

test("advertise dùng name chính, KHÔNG tạo service riêng cho alias (tránh trùng VIPService)", () => {
  const cmds = buildAdvertiseCommands(SERVICES, resolvePublishConfig({ TS_PUBLISH_MODE: "services" }));
  const names = cmds.map((c) => c.service);
  assert.ok(names.includes("svc:webssh"));
  assert.ok(!names.includes("svc:ttyd"), "alias ttyd không được thành service riêng");
});

// ── Cách B: autoApprovers ────────────────────────────────────────────────────
const ACL = {
  grants: [{ src: ["*"], dst: ["*"], ip: ["*"] }],
  ssh: [{ action: "accept", src: ["tag:ci"], dst: ["tag:ci"], users: ["root"] }],
  tagOwners: { "tag:ci": ["autogroup:admin"], "tag:container": ["autogroup:admin"] },
};

test("autoApprovers.services thêm đúng svc + approvers, KHÔNG đụng grants/ssh/tagOwners", () => {
  const cfg = resolvePublishConfig({ TS_PUBLISH_MODE: "services", TS_SERVICES_AUTOAPPROVE: "1" });
  const { nextPolicy, added } = mergeServiceAutoApprovers(ACL, SERVICES, cfg, ["tag:container"]);
  assert.deepEqual(nextPolicy.autoApprovers.services["svc:whoami"], ["tag:container"]);
  assert.deepEqual(nextPolicy.autoApprovers.services["svc:auth"], ["tag:container"]);
  assert.equal(added.length, SERVICES.length);
  // bất biến: các section khác giữ nguyên
  assert.deepEqual(nextPolicy.grants, ACL.grants);
  assert.deepEqual(nextPolicy.ssh, ACL.ssh);
  assert.deepEqual(nextPolicy.tagOwners, ACL.tagOwners);
});

test("autoApprovers no-op khi mode!=services hoặc autoApprove=0", () => {
  const serveOnly = resolvePublishConfig({ TS_PUBLISH_MODE: "serve" });
  assert.equal(mergeServiceAutoApprovers(ACL, SERVICES, serveOnly, ["tag:container"]).nextPolicy, ACL);

  const noApprove = resolvePublishConfig({ TS_PUBLISH_MODE: "services", TS_SERVICES_AUTOAPPROVE: "0" });
  assert.equal(mergeServiceAutoApprovers(ACL, SERVICES, noApprove, ["tag:container"]).nextPolicy, ACL);
});

test("autoApprovers idempotent — chạy 2 lần không nhân đôi approvers", () => {
  const cfg = resolvePublishConfig({ TS_PUBLISH_MODE: "services" });
  const once = mergeServiceAutoApprovers(ACL, SERVICES, cfg, ["tag:container"]).nextPolicy;
  const twice = mergeServiceAutoApprovers(once, SERVICES, cfg, ["tag:container"]);
  assert.deepEqual(twice.nextPolicy.autoApprovers.services["svc:whoami"], ["tag:container"]);
  assert.equal(twice.added.length, 0, "lần 2 không thêm gì");
});

// ── helper ───────────────────────────────────────────────────────────────────
test("serviceNames gộp name + aliases, lọc trùng", () => {
  assert.deepEqual(serviceNames({ name: "webssh", names: ["ttyd", "webssh"] }), ["webssh", "ttyd"]);
  assert.deepEqual(serviceNames({ name: "whoami" }), ["whoami"]);
});

// ── VIP service + approval helpers ───────────────────────────────────────────
test("buildVipServiceBody returns correct body with do-not-validate", () => {
  const body = buildVipServiceBody("svc:whoami");
  assert.deepEqual(body, { name: "svc:whoami", ports: ["do-not-validate"] });
});

test("buildServiceApprovalBody returns { approved: true }", () => {
  assert.deepEqual(buildServiceApprovalBody(), { approved: true });
});

// ── extractHostname ──────────────────────────────────────────────────────────
test("extractHostname parses HostName from tailscale status JSON", () => {
  const json = JSON.stringify({
    Self: { HostName: "proxy-stack-gh-123", Online: true },
    BackendState: "Running",
  });
  assert.equal(extractHostname(json), "proxy-stack-gh-123");
});

test("extractHostname returns empty string for invalid/missing input", () => {
  assert.equal(extractHostname(""), "");
  assert.equal(extractHostname("not json"), "");
  assert.equal(extractHostname(JSON.stringify({ Self: {} })), "");
  assert.equal(extractHostname(null), "");
});

// ── buildVipServiceBody with addrs ──────────────────────────────────────────
test("buildVipServiceBody with addrs includes addrs field", () => {
  const body = buildVipServiceBody("svc:auth", ["100.64.0.1", "fd7a:115c:a1e0::1"]);
  assert.deepEqual(body, {
    name: "svc:auth",
    ports: ["do-not-validate"],
    addrs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
  });
});

test("buildVipServiceBody without addrs omits addrs field", () => {
  const body = buildVipServiceBody("svc:auth");
  assert.deepEqual(body, { name: "svc:auth", ports: ["do-not-validate"] });
});

test("buildVipServiceBody with single addr omits addrs (needs 2)", () => {
  const body = buildVipServiceBody("svc:auth", ["100.64.0.1"]);
  assert.deepEqual(body, { name: "svc:auth", ports: ["do-not-validate"] });
});

// ── buildServicesBody ───────────────────────────────────────────────────────
test("buildServicesBody returns name only (no addrs needed)", () => {
  const body = buildServicesBody("svc:auth");
  assert.deepEqual(body, { name: "svc:auth" });
});

// ── extractAddrs ────────────────────────────────────────────────────────────
test("extractAddrs parses IPv4 and IPv6 from tailscale status", () => {
  const json = JSON.stringify({
    Self: {
      TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::abcd:1234"],
      HostName: "test",
    },
  });
  assert.deepEqual(extractAddrs(json), ["100.64.0.1", "fd7a:115c:a1e0::abcd:1234"]);
});

test("extractAddrs returns single addr if only IPv4 available", () => {
  const json = JSON.stringify({
    Self: { TailscaleIPs: ["100.64.0.1"] },
  });
  assert.deepEqual(extractAddrs(json), ["100.64.0.1"]);
});

test("extractAddrs returns empty for missing/invalid input", () => {
  assert.deepEqual(extractAddrs(""), []);
  assert.deepEqual(extractAddrs("not json"), []);
  assert.deepEqual(extractAddrs(JSON.stringify({ Self: {} })), []);
  assert.deepEqual(extractAddrs(null), []);
});

// ── vipMode in resolvePublishConfig ─────────────────────────────────────────
test("vipMode defaults to auto", () => {
  const cfg = resolvePublishConfig({ TS_PUBLISH_MODE: "services" });
  assert.equal(cfg.vipMode, "auto");
});

test("vipMode=services parsed correctly", () => {
  const cfg = resolvePublishConfig({ TS_PUBLISH_MODE: "services", TS_SERVICES_VIP_MODE: "services" });
  assert.equal(cfg.vipMode, "services");
});

test("vipMode=skip parsed correctly", () => {
  const cfg = resolvePublishConfig({ TS_PUBLISH_MODE: "services", TS_SERVICES_VIP_MODE: "skip" });
  assert.equal(cfg.vipMode, "skip");
});

test("vipMode invalid value falls back to auto with warning", () => {
  const cfg = resolvePublishConfig({ TS_PUBLISH_MODE: "services", TS_SERVICES_VIP_MODE: "bogus" });
  assert.equal(cfg.vipMode, "auto");
  assert.ok(cfg.warnings.some((w) => w.includes("TS_SERVICES_VIP_MODE")));
});
