variable "GIT_SHA" {
  default = "unknown"
}

function "labels" {
  params = [target]
  result = {
    "org.opencontainers.image.revision" = GIT_SHA
    "org.opencontainers.image.source" = "https://github.com/${env("REGISTRY_CACHE")}"
    "org.opencontainers.image.title" = target
  }
}

function "cache_ref" {
  params = [name]
  result = ["type=gha,scope=${name}", "type=registry,ref=${env("REGISTRY_CACHE")}/${name}:buildcache"]
}

group "default" {
  targets = ["webssh", "rclone", "orchestrator", "nodesync"]
}

target "webssh" {
  context    = "./webssh"
  dockerfile = "Dockerfile"
  tags       = ["proxy-stack-webssh:latest"]
  labels     = labels("webssh")
  cache-from = cache_ref("webssh")
  cache-to   = ["type=gha,mode=max,scope=webssh"]
}

target "rclone" {
  context    = "./rclone"
  dockerfile = "Dockerfile"
  tags       = ["proxy-stack-rclone:local"]
  labels     = labels("rclone")
  cache-from = cache_ref("rclone")
  cache-to   = ["type=gha,mode=max,scope=rclone"]
}

target "orchestrator" {
  context    = "./orchestrator"
  dockerfile = "Dockerfile"
  tags       = ["proxy-stack-orchestrator:local"]
  labels     = labels("orchestrator")
  cache-from = cache_ref("orchestrator")
  cache-to   = ["type=gha,mode=max,scope=orchestrator"]
}

target "nodesync" {
  context    = "./nodesync"
  dockerfile = "Dockerfile"
  tags       = ["proxy-stack-nodesync:local"]
  labels     = labels("nodesync")
  cache-from = cache_ref("nodesync")
  cache-to   = ["type=gha,mode=max,scope=nodesync"]
}
