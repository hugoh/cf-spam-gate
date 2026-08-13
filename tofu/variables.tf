variable "zone_id" {
  type        = string
  description = "Zone the protected address belongs to."
}

variable "from" {
  type        = string
  description = "Protected email address, e.g. \"contact@example.com\"."
}

variable "worker_script_name" {
  type        = string
  description = "Name of the deployed cf-spam-gate Worker script (the `name` in its wrangler.toml)."
  default     = "cf-spam-gate"
}

variable "account_id" {
  type        = string
  description = "Cloudflare account ID that owns the ROUTES KV namespace."
}

variable "kv_namespace_id" {
  type        = string
  description = "ID of the worker's ROUTES KV namespace (from `wrangler kv namespace create ROUTES`)."
}

variable "destinations" {
  type        = list(string)
  description = "Where clean (non-spam) mail for `from` actually gets forwarded."
}

variable "threshold" {
  type        = number
  description = "Per-recipient spam-score threshold override (0-1). Leave null to use the worker's DEFAULT_THRESHOLD."
  default     = null
}
