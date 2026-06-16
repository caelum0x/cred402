variable "kubeconfig_path" {
  description = "Path to the kubeconfig file"
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "kubeconfig context to target"
  type        = string
  default     = null
}

variable "namespace" {
  description = "Kubernetes namespace for the Cred402 release"
  type        = string
  default     = "cred402"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "testnet"
  validation {
    condition     = contains(["development", "testnet", "mainnet"], var.environment)
    error_message = "environment must be development, testnet, or mainnet."
  }
}

variable "image_tag" {
  description = "Container image tag to deploy"
  type        = string
  default     = "0.1.0"
}

variable "admin_api_key" {
  description = "Bootstrap admin API key (sensitive)"
  type        = string
  sensitive   = true
}

variable "webhook_secret" {
  description = "Webhook signing secret (sensitive)"
  type        = string
  sensitive   = true
}

variable "ingress_enabled" {
  description = "Expose the API via an ingress"
  type        = bool
  default     = false
}

variable "ingress_host" {
  description = "Hostname for the ingress"
  type        = string
  default     = "api.cred402.example"
}
