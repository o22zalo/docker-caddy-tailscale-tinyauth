group "default" {
  targets = ["webssh", "rclone", "orchestrator", "nodesync"]
}

target "webssh" {
  context    = "./webssh"
  dockerfile = "Dockerfile"
  tags       = ["proxy-stack-webssh:latest"]
  cache-from = ["type=gha,scope=webssh"]
  cache-to   = ["type=gha,mode=max,scope=webssh"]
}

target "rclone" {
  context    = "."
  dockerfile = "rclone/Dockerfile"
  tags       = ["proxy-stack-rclone:local"]
  cache-from = ["type=gha,scope=rclone"]
  cache-to   = ["type=gha,mode=max,scope=rclone"]
}

target "orchestrator" {
  context    = "."
  dockerfile = "orchestrator/Dockerfile"
  tags       = ["proxy-stack-orchestrator:local"]
  cache-from = ["type=gha,scope=orchestrator"]
  cache-to   = ["type=gha,mode=max,scope=orchestrator"]
}

target "nodesync" {
  context    = "."
  dockerfile = "nodesync/Dockerfile"
  tags       = ["proxy-stack-nodesync:local"]
  cache-from = ["type=gha,scope=nodesync"]
  cache-to   = ["type=gha,mode=max,scope=nodesync"]
}
