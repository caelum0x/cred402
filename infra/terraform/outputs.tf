output "namespace" {
  description = "Namespace the Cred402 release was deployed into"
  value       = kubernetes_namespace.cred402.metadata[0].name
}

output "release_name" {
  description = "Helm release name"
  value       = helm_release.cred402.name
}

output "release_status" {
  description = "Helm release status"
  value       = helm_release.cred402.status
}
