#!/usr/bin/env bash
# Tinyauth: interactive user generator (docker-compose format for .env).
set -euo pipefail

docker run --rm -it ghcr.io/steveiliop56/tinyauth:v5 user create --interactive

echo
echo "Paste the output into TINYAUTH_AUTH_USERS in the root .env file."
echo "If the hash contains \$ characters, double them (\$\$) so Docker Compose keeps a single \$."
echo
echo "Only use valid Tinyauth v5 env keys (TINYAUTH_APPURL, TINYAUTH_AUTH_USERS, …)."
echo "Unknown TINYAUTH_* variables cause the container to refuse to start."
