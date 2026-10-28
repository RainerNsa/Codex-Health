variable "target_ids" {
  description = "Organizational unit ids (ou-xxxx-xxxxxxxx) or account ids the three policies attach to. Use the workloads OU, never the root, so the management account keeps the access it needs to recover."
  type        = list(string)

  validation {
    condition     = length(var.target_ids) > 0
    error_message = "At least one OU or account id is required."
  }
}

variable "tags" {
  description = "Tags for the policy objects themselves."
  type        = map(string)
  default     = {}
}
