# Credentials come from the environment (GitHub Actions secrets):
#   NEON_API_KEY, CLOUDFLARE_API_TOKEN, BETTERUPTIME_API_TOKEN.
provider "neon" {}

provider "cloudflare" {}

# Kept for the apply that destroys the last AWS resources (see main.tf); then delete.
provider "aws" {
  region = "ap-southeast-2"
}

# Token comes from the environment: BETTERUPTIME_API_TOKEN (repo secret).
provider "betteruptime" {}
