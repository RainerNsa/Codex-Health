output "vpc_id" {
  value = aws_vpc.this.id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "workers_security_group_id" {
  value = aws_security_group.workers.id
}

output "db_security_group_id" {
  value = aws_security_group.db.id
}

output "endpoint_services" {
  description = "The egress allowlist, for the M4 egress test (dev-alignment 4.4)."
  value       = concat(["s3"], sort(keys(aws_vpc_endpoint.interface)))
}
