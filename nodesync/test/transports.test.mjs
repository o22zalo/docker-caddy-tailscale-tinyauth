import test from "node:test";
import assert from "node:assert/strict";
import { endpoints, isProxyBootstrapFailure, tailscaleHosts } from "../scripts/lib/transports.mjs";

const source = {
  domain: "example.com",
  tailscale: {
    available: true,
    online: true,
    ssh: true,
    dnsName: "runner.tailnet.ts.net.",
    ip: "100.110.98.100",
    ips: ["100.110.98.100", "fd7a:115c:a1e0::323b:6265"],
  },
  ssh: {
    port: 22,
    tailscalePort: 2222,
    ips: ["100.110.98.100", "10.1.0.255", "172.17.0.1", "192.168.1.20", "fe80::1"],
  },
};

test("Tailscale tries MagicDNS then every advertised tailnet IP", () => {
  assert.deepEqual(tailscaleHosts(source), [
    "runner.tailnet.ts.net",
    "100.110.98.100",
    "fd7a:115c:a1e0::323b:6265",
  ]);
});

test("Tailscale endpoints always use host-sshd Serve through userspace SOCKS5", () => {
  const list = endpoints(source).tailscale;
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(({ host, port, proxy, transport, address }) => ({ host, port, proxy, transport, address })), [
    { host: "runner.tailnet.ts.net", port: 2222, proxy: "nc -x tailscale:1055 %h %p", transport: "ts-serve", address: "magicdns" },
    { host: "100.110.98.100", port: 2222, proxy: "nc -x tailscale:1055 %h %p", transport: "ts-serve", address: "tailnet-ip" },
    { host: "fd7a:115c:a1e0::323b:6265", port: 2222, proxy: "nc -x tailscale:1055 %h %p", transport: "ts-serve", address: "tailnet-ip" },
  ]);
});

test("A stale ssh=true manifest never redirects NodeSync to sidecar port 22", () => {
  const list = endpoints(source).tailscale;
  assert.ok(list.every((endpoint) => endpoint.port === 2222));
  assert.ok(list.every((endpoint) => endpoint.transport === "ts-serve"));
});

test("Hybrid excludes tailnet, Docker, link-local and disallowed 10/8 addresses", () => {
  assert.deepEqual(endpoints(source).hybrid, [{ host: "192.168.1.20", port: 22 }]);
});

test("Cloudflare uses the local Access client, never docker exec or the connector", () => {
  const list = endpoints(source).cloudflare;
  assert.equal(list.length, 1);
  assert.equal(list[0].proxy, "cloudflared access ssh --hostname %h");
  assert.equal(list[0].transport, "cloudflare-access-client");
  assert.doesNotMatch(list[0].proxy, /docker|container/i);
});

test("Proxy bootstrap errors are distinguished from SSH authentication failures", () => {
  assert.equal(isProxyBootstrapFailure("sh: cloudflared: not found"), true);
  assert.equal(isProxyBootstrapFailure("nc: not found"), true);
  assert.equal(isProxyBootstrapFailure("Permission denied (publickey)."), false);
});
