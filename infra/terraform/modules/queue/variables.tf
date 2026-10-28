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
