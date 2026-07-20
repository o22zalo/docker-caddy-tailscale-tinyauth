---
name: ssh-containers
description: Use when the user wants to check Docker containers running on remote machines via SSH. Triggers on keywords like "container status", "docker ps", "running containers", "container logs", "remote containers", "check containers", or any request to inspect Docker containers on remote servers.
---

# SSH Containers

Check Docker containers on remote machines via SSH through Tailscale.

## Connection

Use the SSH connect script with Tailscale method:

```bash
node scripts/runners/ssh-connect/ssh-connect.mjs -m tailscale -p 2222 -- [command]
```

Or directly with SSH:

```bash
ssh -i .secret/nodesync_id_ed25519 -o IdentitiesOnly=yes -o PubkeyAuthentication=yes -o PasswordAuthentication=no -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o GlobalKnownHostsFile=NUL -o LogLevel=ERROR -p 2222 nodesync@<tailscale-ip> "sudo docker <command>"
```

## Common Commands

| Task | Command |
|------|---------|
| List all containers | `sudo docker ps -a` |
| List running containers | `sudo docker ps` |
| Container logs | `sudo docker logs <name> --tail <n>` |
| Container inspect | `sudo docker inspect <name>` |
| Container stats | `sudo docker stats --no-stream` |
| Container health | `sudo docker ps --format 'table {{.Names}}\t{{.Status}}'` |

## Workflow

1. **Get Tailscale IP** — run `tailscale status` to find online peers
2. **Connect via SSH** — use the ssh-connect script or direct SSH command
3. **Run docker command** — execute with `sudo` for Docker socket access
4. **Parse output** — format and present to user

## Example Flow

```
User: "show me running containers on the remote machine"

1. tailscale status → find online peer IP (e.g., 100.72.59.39)
2. ssh ... "sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
3. Present formatted table to user
```

```
User: "why is caddy not working?"

1. ssh ... "sudo docker logs caddy --tail 30"
2. ssh ... "sudo docker inspect caddy --format '{{.State.Status}}'"
3. Analyze logs and status, provide diagnosis
```

## Notes

- Always use `sudo` for Docker commands (user `nodesync` not in docker group)
- Default port is 2222 for Tailscale SSH
- Use `--tail N` to limit log output
- For large logs, use `grep` or `head`/`tail` to filter
