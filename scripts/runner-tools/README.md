# runner-tools — cài CLI tool ngoài vào runner (có fallback nhiều phương thức)

Cài các CLI tool bên ngoài (vd `opencode`) **trong CI runner** hoặc máy local, với
**fallback nhiều phương thức**: thử lần lượt từng cách cho tới khi tool `verify` thành công.

## File

- `install-tool.mjs` — engine cài đặt (thử method → verify → dừng khi OK).
- `tools-config.jsonc` — khai báo tool + danh sách method fallback theo thứ tự.

## Dùng

```bash
# Cài 1 tool
node scripts/runner-tools/install-tool.mjs opencode

# Cài nhiều tool
node scripts/runner-tools/install-tool.mjs opencode othertool

# Cài tất cả tool trong config
node scripts/runner-tools/install-tool.mjs --all

# Xem trước sẽ chạy gì, không cài
node scripts/runner-tools/install-tool.mjs opencode --dry-run

# Cài lại dù đã có
node scripts/runner-tools/install-tool.mjs opencode --force

# Đổi timeout mỗi method (giây)
node scripts/runner-tools/install-tool.mjs opencode --timeout=600
```

## Cách hoạt động

1. Nếu tool đã `verify` được (đã cài) → bỏ qua (trừ khi `--force`).
2. Thử từng `method` theo thứ tự. Mỗi method chạy qua `bash -lc` (login shell,
   lấy được PATH của nvm/brew...).
3. `needs`: nếu method cần một binary chưa có (vd `bun`, `brew`) → tự bỏ qua.
4. Sau mỗi method, nạp `pathAdd` vào PATH rồi chạy lệnh `verify`.
   - Trên GitHub Actions, `pathAdd` còn được ghi vào `$GITHUB_PATH` để các step sau thấy tool.
5. Method đầu tiên khiến `verify` thành công → dừng, báo SUCCESS.
6. Hết method mà vẫn chưa verify → exit 1 kèm tóm tắt các lần thử.

## Thêm tool mới

Thêm một entry vào `tools-config.jsonc`:

### Phương thức bash -lc (npm, brew, curl)

```jsonc
{
  "name": "mytool",
  "verify": "mytool --version",
  "pathAdd": ["$HOME/.mytool/bin"],   // optional
  "linkTo": "/usr/local/bin/mytool",  // optional, for SSH users/non-GHA shells
  "methods": [
    { "id": "official-script", "run": "curl -fsSL https://.../install | bash" },
    { "id": "npm",  "needs": "npm",  "run": "npm i -g mytool" },
    { "id": "brew", "needs": "brew", "run": "brew install mytool" }
  ]
}
```

### Phương thức download (tải binary trực tiếp, cache theo version)

```jsonc
{
  "name": "litestream",
  "version": "0.3.13",
  "verify": "litestream version",
  "methods": [
    {
      "id": "binary-download",
      "type": "download",
      "url": {
        "linux-x64": "https://github.com/.../litestream-${version}-linux-amd64.tar.gz",
        "darwin-x64": "https://github.com/.../litestream-${version}-darwin-amd64.tar.gz",
        "darwin-arm64": "https://github.com/.../litestream-${version}-darwin-arm64.tar.gz"
      },
      "binary": "litestream"
    },
    {
      "id": "brew",
      "needs": "brew",
      "run": "brew install litestream"
    }
  ]
}
```

**Lưu ý cho `type: "download"`:**
- `version`: phiên bản tool (dùng trong URL template `${version}`)
- `url`: object key = `${process.platform}-${process.arch}` (vd `linux-x64`, `darwin-arm64`)
- `binary`: tên file binary sau khi extract
- Cache location: `scripts/runner-tools/.cache/<name>/<version>/<platform>/`
- CI cần cache directory `.cache/` giữa các run (xem workflow files)

## Tích hợp GitHub Actions

Cache directory `.cache/` giữa các run. **Không** dùng combined `actions/cache`
(post-if = `success()` only → job fail thì không save). Tách restore/save:

```yaml
- name: Restore runner tools cache
  id: cache-runner-tools
  uses: actions/cache/restore@v5
  with:
    path: scripts/runner-tools/.cache
    key: runner-tools-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('scripts/runner-tools/tools-config.jsonc') }}
    restore-keys: |
      runner-tools-${{ runner.os }}-${{ runner.arch }}-

- name: Install tools
  run: node scripts/runner-tools/install-tool.mjs --all

# always() so later smoke failures still warm the cache (save-always is deprecated)
- name: Save runner tools cache
  if: always() && steps.cache-runner-tools.outputs.cache-hit != 'true'
  uses: actions/cache/save@v5
  with:
    path: scripts/runner-tools/.cache
    key: ${{ steps.cache-runner-tools.outputs.cache-primary-key }}
```

Azure Pipelines: `Cache@2` post-job save vẫn chạy khi step sau fail (không cần
tách). Xem `.azure/azure-pipelines.yml`.

Không cần tự `echo "$HOME/.opencode/bin" >> "$GITHUB_PATH"` — script tự làm qua
`pathAdd`.
