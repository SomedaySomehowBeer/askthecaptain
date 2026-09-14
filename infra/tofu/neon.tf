resource "neon_project" "captain" {
  name       = "askthecaptain"
  region_id  = "aws-ap-southeast-2"
  pg_version = 18

  # Neon Free caps history retention at 6 h; the provider default exceeds it.
  history_retention_seconds = 21600
}

resource "neon_branch" "staging" {
  project_id = neon_project.captain.id
  name       = "staging"
}

resource "neon_endpoint" "staging" {
  project_id     = neon_project.captain.id
  branch_id      = neon_branch.staging.id
  type           = "read_write"
  pooler_enabled = true
}

# The product's database on each branch. The project's default database is left alone.
resource "neon_database" "captain_production" {
  project_id = neon_project.captain.id
  branch_id  = neon_project.captain.default_branch_id
  name       = "captain"
  owner_name = neon_project.captain.database_user
}

resource "neon_database" "captain_staging" {
  project_id = neon_project.captain.id
  branch_id  = neon_branch.staging.id
  name       = "captain"
  owner_name = neon_project.captain.database_user
}

resource "neon_role" "app_production" {
  project_id = neon_project.captain.id
  branch_id  = neon_project.captain.default_branch_id
  name       = "app"
}

resource "neon_role" "app_staging" {
  project_id = neon_project.captain.id
  branch_id  = neon_branch.staging.id
  name       = "app"
}

output "neon_project_id" {
  value = neon_project.captain.id
}

output "neon_connection_host" {
  value     = neon_project.captain.database_host
  sensitive = true
}

output "neon_production_database_url" {
  value     = local.neon_production_app_database_url
  sensitive = true
}

output "neon_staging_database_url" {
  value     = local.neon_staging_app_database_url
  sensitive = true
}

output "neon_production_app_database_url" {
  value     = local.neon_production_app_database_url
  sensitive = true
}

output "neon_staging_app_database_url" {
  value     = local.neon_staging_app_database_url
  sensitive = true
}

locals {
  neon_production_app_database_url = format(
    "postgresql://%s:%s@%s/%s?sslmode=require",
    neon_role.app_production.name,
    urlencode(neon_role.app_production.password),
    neon_project.captain.database_host,
    neon_database.captain_production.name,
  )
  neon_staging_app_database_url = format(
    "postgresql://%s:%s@%s/%s?sslmode=require",
    neon_role.app_staging.name,
    urlencode(neon_role.app_staging.password),
    neon_endpoint.staging.host,
    neon_database.captain_staging.name,
  )
}

output "neon_production_owner_database_url" {
  value = format(
    "postgresql://%s:%s@%s/%s?sslmode=require",
    neon_project.captain.database_user,
    urlencode(neon_project.captain.database_password),
    neon_project.captain.database_host,
    neon_database.captain_production.name,
  )
  sensitive = true
}

output "neon_staging_owner_database_url" {
  value = format(
    "postgresql://%s:%s@%s/%s?sslmode=require",
    neon_project.captain.database_user,
    urlencode(neon_project.captain.database_password),
    neon_endpoint.staging.host,
    neon_database.captain_staging.name,
  )
  sensitive = true
}
