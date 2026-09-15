terraform {
  required_version = ">= 1.8"

  backend "s3" {
    bucket                      = "askthecaptain-tofu-state"
    key                         = "prod/terraform.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://fly.storage.tigris.dev" }
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = false
  }

  required_providers {
    neon         = { source = "kislerdm/neon", version = "~> 0.9" }
    cloudflare   = { source = "cloudflare/cloudflare", version = "~> 5.0" }
    betteruptime = { source = "BetterStackHQ/better-uptime", version = "~> 0.21" }
  }
}

# Fly apps are NOT managed here (Fly's Terraform provider is unmaintained):
# see apps/*/fly.toml + .github/workflows/deploy.yml.
