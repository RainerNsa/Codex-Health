terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.82"
    }
  }

  # State lives in S3 with a DynamoDB lock. Bucket, key, region and table come
  # from `-backend-config=backend.hcl` (see backend.hcl.example); nothing is
  # hardcoded here.
  backend "s3" {}
}
