---
description: Review git diff against AGENTS.md rules, check impact and violations
---

Review current git changes for correctness, impact, and AGENTS.md compliance.

## Steps

### 1. Gather changes

```bash
git diff --stat
git diff --cached --stat
git diff
git diff --cached
git status
```

If no changes, stop and report "Nothing to review".

### 2. Identify changed files and categorize

Group changed files by:

- **Compose YAML** (`*.yml` in service dirs, `docker-compose*.yml`)
- **Env files** (`.env`, `.env.example`, `.env.ci`, `*/.env.example`)
- **Scripts** (`*.mjs`, `*.js`)
- **CI/CD** (`.github/workflows/*`, `.azure/*`)
- **Service configs** (Caddyfile, serve.json, Dockerfile, etc.)
- **Docs** (`AGENTS.md`, `README.md`, `docs/*`)

### 3. For each changed file, check AGENTS.md rules

#### Compose YAML checks

- File named `<service>/<service>.yml`? Not `docker-compose.yml` inside service dir?
- Has `profiles:` array? Not empty?
- Attached to `proxy` network?
- Has comment header (purpose + doc links)?
- No `environment: KEY: ${KEY:-}` empty injection?
- Uses `env_file:` for optional vars?

#### Env file checks

- Root `.env.example` is minimal (not full catalog)?
- Service `.env.example` has full catalog with docs links?
- No real secrets committed (`CF_TUNNEL_TOKEN`, `TS_AUTHKEY`, passwords)?
- `COMPOSE_PROFILES` set appropriately?

#### Script checks

- Service scripts in `<service>/scripts/`? Not in root `scripts/`?
- Stack-wide scripts in `scripts/`?
- CI runners in `scripts/runners/`?
- Supports `--dry-run` and `--silent` flags?
- Uses `dotenv.parse()` not regex for `.env` reading?
- No multi-step bash inline in YAML?

#### Profile checks

- Service has own profile name?
- Added to `core` and/or `full` if appropriate?
- Profile map in AGENTS.md updated?

#### Naming checks

- One directory per service?
- Compose file name matches service name?
- No hardcoded repo owner/name in CI/Dockerfiles?

#### CI checks

- `docker-compose.ci.yml` still works for quick tunnel?
- `wait-and-test.mjs` accepts 302/401 without `curl -L`?
- Log collection configured?

### 4. Impact analysis

For each changed file, determine:

- **What depends on this?** (grep for imports, includes, references)
- **What breaks if this is wrong?** (stack won't start, CI fails, auth broken)
- **Cross-service effects?** (network, profiles, env vars shared)

Use `grep` and `glob` to find:

- Files that import/include the changed file
- Services that reference changed env vars
- Scripts that call the changed script
- Compose files that depend on changed network/profile

### 5. Check docs consistency

If AGENTS.md, README.md, or service `.env.example` changed:

- Are the changes reflected in all related files?
- Profile map table still accurate?
- Multi-file list in README still complete?
- Service folder table still accurate?

### 6. Output format

Write the final review report in Vietnamese. Keep code, file paths, commands, YAML/env keys, and rule names in their original form (do not translate them); translate the surrounding descriptions, statuses, and explanations into Vietnamese.

Report in this structure:

```markdown
## Tóm tắt Review

**Số file thay đổi:** N
**Mức độ rủi ro:** Thấp / Trung bình / Cao

---

### [file/path] — ✅ Ổn / ⚠️ Cảnh báo / ❌ Vi phạm

**Thay đổi:** Mô tả ngắn gọn thay đổi là gì
**Quy tắc:** Quy tắc nào trong AGENTS.md áp dụng
**Trạng thái:** Đạt/Không đạt kèm giải thích
**Tác động:** Có thể gây hỏng gì
**Cách sửa:** Hành động cụ thể cần làm (nếu là vi phạm)

---

### Vấn đề liên quan nhiều file

- Liệt kê các vấn đề ảnh hưởng nhiều file
- Các cập nhật còn thiếu ở docs/config liên quan

### Đề xuất

1. Gợi ý cải thiện cụ thể
2. Các phần còn thiếu để hoàn tất thay đổi
3. Các bước kiểm thử để xác nhận
```

### 7. Severity levels

- **❌ Vi phạm (Violation)**: Vi phạm quy tắc AGENTS.md, sẽ gây lỗi runtime/CI
- **⚠️ Cảnh báo (Warning)**: Vấn đề tiềm ẩn, có thể chạy được nhưng thiếu ổn định hoặc không nhất quán
- **✅ Ổn (OK)**: Tuân thủ quy ước, không có vấn đề
- **ℹ️ Gợi ý (Info)**: Đề xuất cải thiện, không phải vi phạm

### 8. Common violations to flag

| Pattern                                          | Rule violated       |
| ------------------------------------------------ | ------------------- |
| `environment: KEY: ${KEY:-}`                     | Env injection rules |
| Missing `profiles:`                              | Profile principles  |
| Script in wrong directory                        | Scripts placement   |
| Real secret in `.env.example`                    | Security            |
| Inline bash in YAML > 4 lines                    | Inline code rules   |
| `docker-compose.yml` in service dir              | Naming rules        |
| Missing comment header in Compose YAML           | Naming rules        |
| `curl -L` in smoke test                          | CI requirements     |
| Hardcoded repo owner/name                        | No hardcoded repo   |
| Script without `--dry-run`/`--silent`            | Script flags        |
| `.env` parsed with regex not dotenv              | .env parsing rules  |
| Empty optional env injected                      | Env injection rules |
| Service missing from profile map                 | Profile principles  |
| Missing `core`/`full` profile for public service | Profile principles  |

$ARGUMENTS
