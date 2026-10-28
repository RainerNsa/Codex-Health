variable "target_ids" {
  description = "The workloads OU id (ou-xxxx-xxxxxxxx) holding dev, test and prod. Never the organization root."
  type        = list(string)
}
