# Cred402 infrastructure — deploys the Helm chart + secrets onto an existing
# Kubernetes cluster. Cloud-agnostic (kubernetes + helm providers); point it at
# any cluster via the kubeconfig variables.

terraform {
  required_version = ">= 1.5"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.20"
    }
    helm = {
      source  = "hashicorp/helm"
      version = ">= 2.10"
    }
  }
}

provider "kubernetes" {
  config_path    = var.kubeconfig_path
  config_context = var.kube_context
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig_path
    config_context = var.kube_context
  }
}

resource "kubernetes_namespace" "cred402" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/part-of" = "cred402"
      environment                 = var.environment
    }
  }
}

# Secrets are provided out-of-band (never in state plaintext where avoidable).
resource "kubernetes_secret" "cred402" {
  metadata {
    name      = "cred402-secrets"
    namespace = kubernetes_namespace.cred402.metadata[0].name
  }
  data = {
    CRED402_ADMIN_API_KEY = var.admin_api_key
    CRED402_WEBHOOK_SECRET = var.webhook_secret
  }
  type = "Opaque"
}

resource "helm_release" "cred402" {
  name      = "cred402"
  namespace = kubernetes_namespace.cred402.metadata[0].name
  chart     = "${path.module}/../helm/cred402"

  set {
    name  = "image.tag"
    value = var.image_tag
  }
  set {
    name  = "env.CRED402_ENV"
    value = var.environment
  }
  set {
    name  = "ingress.enabled"
    value = tostring(var.ingress_enabled)
  }
  set {
    name  = "ingress.host"
    value = var.ingress_host
  }

  depends_on = [kubernetes_secret.cred402]
}
