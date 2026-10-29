variable "environment" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "visibility_timeout_seconds" {
  description = "Must exceed the longest OCR + extraction job for one document. 15 minutes until the M0 cost spike (dev-alignment 0.8) measures real timings."
  type        = number
  default     = 900
}

variable "max_receive_count" {
  description = "Deliveries before a message moves to the DLQ."
  type        = number
  default     = 3
}

variable "sender_role_arns" {
  description = "Role ARNs allowed sqs:SendMessage on the processing queue: the API task role (modules/compute-roles). Empty means nobody may send."
  type        = list(string)
  default     = []
}

variable "consumer_role_arns" {
  description = "Role ARNs allowed to receive, delete and change visibility: the worker task role (modules/compute-roles). Empty means nobody may consume."
  type        = list(string)
  default     = []
}
