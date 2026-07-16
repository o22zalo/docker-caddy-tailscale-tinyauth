# Deploy Rclone data sync

Rclone pull dữ liệu từ remote về trước khi app start, rồi container `rclone`
định kỳ push local lên remote. Config dùng block indexed `RCLONE_<index>_*`.

## Luồng chạy

1. `scripts/up.mjs` hoặc CI `scripts/runners/start-stack.mjs` đọc root `.env`.
2. Nếu có `RCLONE_<index>_NAME`, helper auto-enable profile `rclone`.
3. Helper đặt container name từ block đầu tiên: `rclone-<index>-<name>`.
4. `rclone/scripts/pull.mjs` pull tất cả jobs song song.
5. Container `rclone` chạy `sync-loop.mjs` và push theo `RCLONE_<index>_INTERVAL`.

Không cần thêm `rclone` vào `COMPOSE_PROFILES` khi dùng `node scripts/up.mjs`
hoặc CI. Nếu chạy `docker compose up` trực tiếp, Compose không tự suy luận được
profile fallback này.

Nếu remote folder/file chưa tồn tại ở lần chạy đầu, `pull.mjs` coi đó là trạng
thái hợp lệ và cho stack đi tiếp. Container `rclone` sẽ push local lên remote ở
lần sync kế tiếp.

## Storage layout

Rclone mount cố định các root workspace:

```text
..                                                -> /workspace
${DOCKER_VOLUME_DATA_ABS:-../ci-data}             -> /data
${DOCKER_VOLUME_RUNTIME_ABS:-../ci-runtime}       -> /runtime
${DOCKER_VOLUME_RUNTIME_ABS:-../ci-runtime}/rclone -> /config/rclone
```

`RCLONE_<index>_LOCAL` có thể dùng `/data/...`, `/runtime/...`,
`/workspace/...`, `./ci-runtime/...`, `${DOCKER_VOLUME_RUNTIME}/...`, hoặc
`{DOCKER_VOLUME_RUNTIME}/...`.

### Cách dùng từng mount

Workspace root:

```env
RCLONE_0_LOCAL=./ci-runtime/tailscale
RCLONE_0_LOCAL=/workspace/ci-runtime/tailscale
```

Data root:

```env
DOCKER_VOLUME_DATA=./ci-data
RCLONE_0_LOCAL=${DOCKER_VOLUME_DATA}/rclone/uploads
RCLONE_0_LOCAL={DOCKER_VOLUME_DATA}/rclone/uploads
RCLONE_0_LOCAL=/data/rclone/uploads
```

Tất cả map về:

```text
./ci-data/rclone/uploads
```

Runtime root:

```env
DOCKER_VOLUME_RUNTIME=./ci-runtime
RCLONE_0_LOCAL=${DOCKER_VOLUME_RUNTIME}/tailscale
RCLONE_0_LOCAL={DOCKER_VOLUME_RUNTIME}/tailscale
RCLONE_0_LOCAL=/runtime/tailscale
```

Tất cả map về:

```text
./ci-runtime/tailscale
```

Rclone config root:

```text
./ci-runtime/rclone/<index>-<name>.conf -> /config/rclone/<index>-<name>.conf
```

Đây là config do script generate từ `RCLONE_<index>_CONFIG_RAW` hoặc
`RCLONE_<index>_CONFIG_BASE64`; không dùng `RCLONE_<index>_LOCAL` để trỏ vào
đây trừ khi thật sự muốn sync chính config rclone.

Rclone-managed app data nên nằm dưới:

```text
/data/rclone/<name>/  ->  ${DOCKER_VOLUME_DATA}/rclone/<name>/
```

Runtime service paths dùng cùng root:

```text
${DOCKER_VOLUME_RUNTIME}/<service>/  ->  /runtime/<service>/
```

Ví dụ:

```env
RCLONE_0_NAME=tinyauth-db
RCLONE_0_TAGS=app,data
RCLONE_0_LOCAL=${DOCKER_VOLUME_DATA}/rclone/tinyauth-db/tinyauth.db
```

Map về workspace:

```text
./ci-data/rclone/tinyauth-db/tinyauth.db
```

Ví dụ Tailscale runtime:

```env
DOCKER_VOLUME_RUNTIME=./ci-runtime
RCLONE_0_NAME=tailscale-runtime
RCLONE_0_TAGS=tailscale,runtime
RCLONE_0_TYPE=dir
RCLONE_0_LOCAL=${DOCKER_VOLUME_RUNTIME}/tailscale
```

Map về workspace:

```text
./ci-runtime/tailscale
```

## Một file

```env
RCLONE_0_NAME=tinyauth-db
RCLONE_0_TYPE=file
RCLONE_0_LOCAL=${DOCKER_VOLUME_DATA}/rclone/tinyauth-db/tinyauth.db
RCLONE_0_REMOTE=remote:proxy-stack/tinyauth.db
RCLONE_0_INTERVAL=300
RCLONE_0_CONFIG_BASE64=...
```

## Cả thư mục

```env
RCLONE_1_NAME=uploads
RCLONE_1_TYPE=dir
RCLONE_1_LOCAL=${DOCKER_VOLUME_DATA}/rclone/uploads
RCLONE_1_REMOTE=remote:proxy-stack/uploads
RCLONE_1_INTERVAL=300
RCLONE_1_CONFIG_BASE64=...
```

## Config raw hoặc base64

Base64 khuyến nghị cho GitHub `ENV_FILE`:

```bash
base64 -w0 rclone.conf
```

```env
RCLONE_0_CONFIG_BASE64=...
```

Raw dùng được nếu secret giữ newline đúng:

```env
RCLONE_0_CONFIG_RAW="[remote]
type = s3
provider = Cloudflare
access_key_id = ...
secret_access_key = ...
endpoint = https://..."
```

Hoặc viết một dòng với `\n`; script sẽ đổi thành newline thật trước khi ghi
`/config/rclone/<index>-<name>.conf`:

```env
RCLONE_0_CONFIG_RAW="[remote]\ntype = s3\nprovider = Other\n..."
```

## Hiệu năng

Jobs chạy song song. Default trong `rclone/scripts/rclone.jsonc`:

```jsonc
{
  "concurrency": 8,
  "transfers": 8,
  "checkers": 16,
  "interval_seconds": 300
}
```

Tăng khi remote/network chịu được; giảm khi bị rate limit.

## Chạy theo tags

```bash
RCLONE_TAGS=tailscale node rclone/scripts/pull.mjs --env .env
node rclone/scripts/pull.mjs --env .env --tags tailscale
node rclone/scripts/sync-loop.mjs --env .env --tags app,data --dry-run
```

## Docker image cache

Rclone dùng image build local `proxy-stack-rclone:local` từ `rclone/Dockerfile`.
CI cache helper đã include:

```text
rclone/rclone.yml
rclone/Dockerfile
```

Vì vậy cache key đổi khi Dockerfile hoặc compose đổi, và image local được save
vào Docker image cache sau `compose up`.
