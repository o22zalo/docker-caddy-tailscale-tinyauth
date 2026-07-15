# Deploy Litestream với Supabase S3

Litestream restore SQLite DB trước khi app start, rồi replicate thay đổi lên S3-compatible storage. Repo này dùng một service Litestream chung, cấu hình bằng các block `LITESTREAM_<index>_*`.

## Luồng chạy

1. `scripts/up.mjs` hoặc CI `scripts/runners/start-stack.mjs` đọc root `.env`.
2. `litestream/scripts/generate-config.mjs` tạo `${DOCKER_VOLUME_RUNTIME}/litestream/litestream.yml`.
3. `litestream/scripts/restore.mjs` restore DB nếu local chưa có.
4. Nếu S3 chưa có backup, restore bỏ qua để app tự tạo DB.
5. Khi container chạy, service `litestream` replicate DB lên S3.

## Storage layout

Mọi DB dùng Litestream phải nằm dưới:

```text
${DOCKER_VOLUME_DATA}/litestream/<service>/
```

Ví dụ Tinyauth:

```text
./ci-data/litestream/tinyauth/tinyauth.db
```

Trong container:

```text
/data/tinyauth/tinyauth.db
```

## Cấu hình Supabase S3

Trong Supabase Dashboard:

1. Mở project.
2. Vào Storage.
3. Tạo bucket, ví dụ `hoahien7281`.
4. Tạo S3 access key.
5. Endpoint dạng:

```text
https://<project-ref>.storage.supabase.co/storage/v1/s3
```

## Env tối thiểu

Chỉ cần `BUCKET`; nếu không set `KEY`, script tự dùng:

```text
<service>/<db filename>
```

Với Tinyauth, key tự động là:

```text
tinyauth/tinyauth.db
```

```env
LITESTREAM_IMAGE=litestream/litestream:0.3.13
LITESTREAM_0_SERVICE=tinyauth
LITESTREAM_0_PATH=/data/tinyauth/tinyauth.db
LITESTREAM_0_BUCKET=your-bucket
LITESTREAM_0_ACCESS_KEY_ID=...
LITESTREAM_0_SECRET_ACCESS_KEY=...
LITESTREAM_0_ENDPOINT=https://project-ref.storage.supabase.co/storage/v1/s3
LITESTREAM_0_REGION=auto
LITESTREAM_0_FORCE_PATH_STYLE=true
```

## Env với key tự đặt

```env
LITESTREAM_0_SERVICE=tinyauth
LITESTREAM_0_PATH=/data/tinyauth/tinyauth.db
LITESTREAM_0_BUCKET=your-bucket
LITESTREAM_0_KEY=prod/tinyauth.db
```

Script sẽ tạo URL:

```text
s3://your-bucket/prod/tinyauth.db
```

## Nhiều service

Tăng index, không sửa script:

```env
LITESTREAM_1_SERVICE=myapp
LITESTREAM_1_PATH=/data/myapp/app.db
LITESTREAM_1_BUCKET=your-bucket
LITESTREAM_1_KEY=myapp/app.db
LITESTREAM_1_ACCESS_KEY_ID=...
LITESTREAM_1_SECRET_ACCESS_KEY=...
LITESTREAM_1_ENDPOINT=https://project-ref.storage.supabase.co/storage/v1/s3
LITESTREAM_1_REGION=auto
LITESTREAM_1_FORCE_PATH_STYLE=true
```

## Kiểm tra trước khi up

```bash
node litestream/scripts/generate-config.mjs --env .env --dry-run
node litestream/scripts/restore.mjs --env .env --dry-run
```

Nếu config hợp lệ, log sẽ có:

```text
Litestream config: 1 db(s)
Litestream profile required: litestream
```

## Start

```bash
node scripts/up.mjs
```

Helper sẽ auto-enable profile `litestream` khi thấy `LITESTREAM_<index>_SERVICE`.

## Lỗi thường gặp

`Litestream config: 0 db(s)`:

- Thiếu `LITESTREAM_0_SERVICE`.
- Thiếu cả `LITESTREAM_0_BUCKET` lẫn `LITESTREAM_0_URL`.
- `.env` đang chạy không phải file bạn vừa sửa.

`restore` báo remote không tồn tại:

- Đây là lần chạy đầu. Không fatal. App tạo DB, Litestream sync lên sau.

Credential/network error:

- Sai `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `ENDPOINT`, bucket policy, hoặc network.
- Đây là lỗi fatal vì có thể làm mất restore thật.
