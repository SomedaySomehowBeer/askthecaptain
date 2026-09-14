resource "aws_kms_key" "tenant_master" {
  description             = "Ask The Captain — master key wrapping per-tenant data keys (envelope encryption)"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "tenant_master" {
  name          = "alias/askthecaptain-tenant-master"
  target_key_id = aws_kms_key.tenant_master.key_id
}
