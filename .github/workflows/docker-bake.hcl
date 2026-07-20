variable "GIT_SHA" {
  default = "unknown"
}

function "labels" {
  params = [target]
  result = {
    "org.opencontainers.image.revision" = GIT_SHA
    "org.opencontainers.image.source" = "https://github.com/hoahien7281/docker-caddy-tailscale-tinyauth"
    "org.opencontainers.image.title" = target
  }
}

group "default" {
  targets = ["webssh", "rclone", "orchestrator", "nodesync"]
}

target "webssh" {
  context    = "./webssh"
  dockerfile = "Dockerfile"
  tags       = ["proxy-stack-webssh:latest"]
  labels     = labels("webssh")
  cache-from = ["type=gha,scope=webssh"]
  cache-to   = ["type=gha,mode=max,scope=webssh"]
}

target "rclone" {
  context    = "./rclone"
  dockerfile = "Dockerfile"
  tags       = ["proxy-stack-rclone:local"]
  labels     = labels("rclone")
  cache-from = ["type=gha,scope=rclone"]
  cache-to   = ["type=gha,mode=max,scope=rclone"]
}

target "orchestrator" {
  context    = "."
  dockerfile = "orchestrator/Dockerfile"
  tags       = ["proxy-stack-orchestrator:local"]
  labels     = labels("orchestrator")
  cache-from = ["type=gha,scope=orchestrator"]
  cache-to   = ["type=gha,mode=max,scope=orchestrator"]
}

target "nodesync" {
  context    = "."
  dockerfile = "nodesync/Dockerfile"
  tags       = ["proxy-stack-nodesync:local"]
  labels     = labels("nodesync")
  cache-from = ["type=gha,scope=nodesync"]
  cache-to   = ["type=gha,mode=max,scope=nodesync"]
}
