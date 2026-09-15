resource "neon_project" "captain" {
  name       = "askthecaptain"
  region_id  = "aws-ap-southeast-2"
  pg_version = 18

  # Neon Free caps history retention at 6 h; the provider default exceeds it.
  history_retention_seconds = 21600
}

# One branch and one compute: every environment reads and writes this database until a second
# customer justifies more (D17).
resource "neon_database" "captain" {
  project_id = neon_project.captain.id
  branch_id  = neon_project.captain.default_branch_id
  name       = "captain"
  owner_name = neon_project.captain.database_user
}

resource "neon_role" "app" {
  project_id = neon_project.captain.id
  branch_id  = neon_project.captain.default_branch_id
  name       = "app"
}

output "neon_project_id" {
  value = neon_project.captain.id
}

output "neon_connection_host" {
  value     = neon_project.captain.database_host
  sensitive = true
}

output "neon_app_database_url" {
  value     = local.neon_app_database_url
  sensitive = true
}

locals {
  neon_app_database_url = format(
    "postgresql://%s:%s@%s/%s?sslmode=require",
    neon_role.app.name,
    urlencode(neon_role.app.password),
    neon_project.captain.database_host,
    neon_database.captain.name,
  )
}

output "neon_owner_database_url" {
  value = format(
    "postgresql://%s:%s@%s/%s?sslmode=require",
    neon_project.captain.database_user,
    urlencode(neon_project.captain.database_password),
    neon_project.captain.database_host,
    neon_database.captain.name,
  )
  sensitive = true
}

