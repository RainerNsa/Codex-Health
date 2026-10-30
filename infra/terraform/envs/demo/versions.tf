terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.82"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Local state on the founder's machine (terraform.tfstate, gitignored): one person, one account, a demo.
  # The state holds the gate password and the origin secret; keep the file private and never commit it.
}
