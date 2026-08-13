# Routes a single address to the cf-spam-gate Worker instead of forwarding
# it directly, and writes the worker's ROUTES KV entry that tells it where
# clean (non-spam) mail for this address should actually go. One module
# call fully wires an address end-to-end — no separate manual KV step.
#
# Requires Email Routing to already be enabled on the zone (e.g. via
# cloudflare_email_routing_settings in the calling root module) and the
# worker to already be deployed under `var.worker_script_name`.
resource "cloudflare_email_routing_rule" "spam_gated" {
  zone_id = var.zone_id
  name    = "Spam-gated routing of ${var.from}"
  enabled = true

  matchers = [{
    type  = "literal"
    field = "to"
    value = var.from
  }]

  actions = [{
    type  = "worker"
    value = [var.worker_script_name]
  }]
}

resource "cloudflare_workers_kv" "route" {
  account_id   = var.account_id
  namespace_id = var.kv_namespace_id
  key_name     = var.from

  value = jsonencode(merge(
    { destinations = var.destinations },
    var.threshold != null ? { threshold = var.threshold } : {}
  ))
}
