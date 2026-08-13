output "rule_id" {
  value       = cloudflare_email_routing_rule.spam_gated.id
  description = "ID of the created email routing rule."
}
