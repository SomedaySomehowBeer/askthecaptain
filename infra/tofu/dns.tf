# DNS hosted at Cloudflare (registrar stays Namecheap; nameservers point at Cloudflare).
variable "cloudflare_zone_id" {
  type = string
}

resource "cloudflare_dns_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = "api"
  type    = "CNAME"
  content = "askthecaptain-api.fly.dev"
  proxied = false
  ttl     = 300
}

resource "cloudflare_dns_record" "api_staging" {
  zone_id = var.cloudflare_zone_id
  name    = "api-staging"
  type    = "CNAME"
  content = "askthecaptain-api-staging.fly.dev"
  proxied = false
  ttl     = 300
}

resource "cloudflare_dns_record" "app" {
  zone_id = var.cloudflare_zone_id
  name    = "app"
  type    = "CNAME"
  content = "askthecaptain-web-staging.fly.dev"
  proxied = false
  ttl     = 300
}

resource "cloudflare_dns_record" "apex" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "CNAME"
  content = "askthecaptain-web-staging.fly.dev"
  proxied = false
  ttl     = 300
}

resource "cloudflare_dns_record" "www" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  type    = "CNAME"
  content = "askthecaptain-web-staging.fly.dev"
  proxied = false
  ttl     = 300
}
# Fly certificate-validation records (_acme-challenge.*) are added after `fly certs add`.
