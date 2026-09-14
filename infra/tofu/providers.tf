# Credentials come from the environment (GitHub Actions secrets):
#   NEON_API_KEY, CLOUDFLARE_API_TOKEN, BETTERUPTIME_API_TOKEN.
provider "neon" {}

provider "cloudflare" {}

# Token comes from the environment: BETTERUPTIME_API_TOKEN (repo secret).
provider "betteruptime" {}
