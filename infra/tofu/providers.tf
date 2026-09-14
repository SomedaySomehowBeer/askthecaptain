# Credentials come from the environment (GitHub Actions secrets):
#   NEON_API_KEY, CLOUDFLARE_API_TOKEN, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, BETTERUPTIME_API_TOKEN.
provider "neon" {}

provider "cloudflare" {}

provider "aws" {
  region = "ap-southeast-2"
}

# Token comes from the environment: BETTERUPTIME_API_TOKEN (repo secret).
provider "betteruptime" {}
