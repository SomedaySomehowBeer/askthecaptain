# Runtime principal for the API/worker on Fly: may only use the tenant master key for envelope encryption.
resource "aws_iam_user" "api_runtime" {
  name = "askthecaptain-api-runtime"
}

resource "aws_iam_user_policy" "api_runtime_kms" {
  name = "askthecaptain-api-kms"
  user = aws_iam_user.api_runtime.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt", "kms:DescribeKey"]
      Resource = aws_kms_key.tenant_master.arn
    }]
  })
}

resource "aws_iam_access_key" "api_runtime" {
  user = aws_iam_user.api_runtime.name
}

output "api_runtime_access_key_id" {
  value = aws_iam_access_key.api_runtime.id
}

output "api_runtime_secret_access_key" {
  value     = aws_iam_access_key.api_runtime.secret
  sensitive = true
}
