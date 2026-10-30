provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project     = "codex-health"
      environment = "demo"
      managed_by  = "terraform"
    }
  }
}
