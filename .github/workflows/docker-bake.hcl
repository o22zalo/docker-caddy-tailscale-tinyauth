variable "REGISTRY_CACHE" {
  default = ""
}

variable "GIT_SHA" {
  default = "unknown"
}

function "labels" {
  params = [target]
  result = {
    "org.opencontainers.image.revision" = GIT_SHA
    "org.opencontainers.image.source" = "https://github.com/${REGISTRY_CACHE}"
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
  cache-from = ["type=gha,scope=webssh", "type=registry,ref=${REGISTRY_CACHE}/webssh:buildcache"]
  cache-to   = ["type=gha,mode=max,scope=webssh"]
}

target "rclone" {
  context    = "./rclone"
  dockerfile = "Dockerfile"
  tags       = ["proxy-stack-rclone:local"]
  labels     = labels("rclone")
  cache-from = ["type=gha,scope=rclone", "type=registry,ref=${REGISTRY_CACHE}/rclone:buildcache"]
  cache-to   = ["type=gha,mode=max,scope=rclone"]
}

target "orchestrator" {
  context    = "./orchestrator"
  dockerfile = "Dockerfile"
  tags       = ["proxy-stack-orchestrator:local"]
  labels     = labels("orchestrator")
  cache-from = ["type=gha,scope=orchestrator", "type=registry,ref=${REGISTRY_CACHE}/orchestrator:buildcache"]
  cache-to   = ["type=gha,mode=max,scope=orchestrator"]
}

target "nodesync" {
  context    = "./nodesync"
  dockerfile = "Dockerfile"
  tags       = ["proxy-stack-nodesync:local"]
  labels     = labels("nodesync")
  cache-from = ["type=gha,scope=nodesync", "type=registry,ref=${REGISTRY_CACHE}/nodesync:buildcache"]
  cache-to   = ["type=gha,mode=max,scope=nodesync"]
}
