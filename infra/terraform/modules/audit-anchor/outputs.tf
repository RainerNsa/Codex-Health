output "bucket_name" {
  value = aws_s3_bucket.anchor.id
}

output "bucket_arn" {
  value = aws_s3_bucket.anchor.arn
}

output "key_arn" {
  value = aws_kms_key.anchor.arn
}
