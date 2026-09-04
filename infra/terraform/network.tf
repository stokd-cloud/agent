# ── VPC ───────────────────────────────────────────────────────────────────────
# Endpoint-only egress by design: there is no NAT gateway and no Elastic IP.
# Private workloads reach AWS services through interface/gateway endpoints only,
# which is what keeps the Agent data plane off the public internet. The
# infrastructure manifest asserts both collections are empty, so adding a NAT
# here fails validation rather than silently widening egress.

resource "aws_vpc" "agent" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.runtime_tags, { Name = "stokd-agent-${var.stage}" })
}

resource "aws_internet_gateway" "agent" {
  vpc_id = aws_vpc.agent.id
  tags   = merge(local.runtime_tags, { Name = "stokd-agent-${var.stage}" })
}

resource "aws_subnet" "public" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.agent.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(aws_vpc.agent.cidr_block, 8, each.value)

  # The validated topology has this on for the load-balancer subnets. Nothing
  # is launched into them directly -- the ALB manages its own addresses -- so
  # this changes no instance's exposure; it keeps the readback identical to the
  # topology the contract was written against.
  map_public_ip_on_launch = true

  tags = merge(local.runtime_tags, {
    Name    = "stokd-agent-${var.stage}-public-${each.key}"
    Network = "public-alb"
  })
}

resource "aws_subnet" "private" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id            = aws_vpc.agent.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(aws_vpc.agent.cidr_block, 8, each.value + length(local.azs))

  tags = merge(local.runtime_tags, {
    Name    = "stokd-agent-${var.stage}-private-${each.key}"
    Network = "private-endpoint-only"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.agent.id
  tags   = merge(local.runtime_tags, { Name = "stokd-agent-${var.stage}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.agent.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# One private route table per AZ. They carry no default route; the only
# non-local entry is the S3 gateway endpoint association below.
resource "aws_route_table" "private" {
  for_each = aws_subnet.private

  vpc_id = aws_vpc.agent.id
  tags   = merge(local.runtime_tags, { Name = "stokd-agent-${var.stage}-private-${each.key}" })
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_service_discovery_private_dns_namespace" "agent" {
  name = "sst"
  vpc  = aws_vpc.agent.id
  tags = local.runtime_tags
}

# ── Security groups ───────────────────────────────────────────────────────────
# Every group starts empty. Every flow is an explicit, separately-readable rule
# so the structure verifier can enumerate them one by one.

resource "aws_security_group" "endpoints" {
  name        = "stokd-agent-endpoints-${var.stage}"
  description = "TLS only from Agent workloads to private AWS endpoints"
  vpc_id      = aws_vpc.agent.id
  tags        = local.runtime_tags
}

resource "aws_security_group" "mongo" {
  name        = "stokd-agent-mongo-${var.stage}"
  description = "MongoDB only from the exact Agent API security group"
  vpc_id      = aws_vpc.agent.id
  tags        = local.runtime_tags
}

resource "aws_security_group" "api" {
  name        = "stokd-agent-api-${var.stage}"
  description = "Private Fargate API tasks"
  vpc_id      = aws_vpc.agent.id
  tags        = local.runtime_tags
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_mongo" {
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = aws_security_group.mongo.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Mongo host to private AWS endpoints"
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_api" {
  security_group_id            = aws_security_group.endpoints.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "API tasks to private AWS endpoints"
}

resource "aws_vpc_security_group_ingress_rule" "mongo_from_api" {
  security_group_id            = aws_security_group.mongo.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 27017
  to_port                      = 27017
  description                  = "Only the exact Agent API group may reach MongoDB"
}

resource "aws_vpc_security_group_egress_rule" "mongo_to_endpoints" {
  security_group_id            = aws_security_group.mongo.id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "Mongo host egress to private AWS endpoints"
}

resource "aws_vpc_security_group_egress_rule" "api_to_endpoints" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "API task egress to private AWS endpoints"
}

resource "aws_vpc_security_group_egress_rule" "api_to_mongo" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.mongo.id
  ip_protocol                  = "tcp"
  from_port                    = 27017
  to_port                      = 27017
  description                  = "API task egress to MongoDB"
}

# In-VPC DNS only. Resolution never leaves the VPC CIDR.
resource "aws_vpc_security_group_egress_rule" "dns_udp" {
  for_each = {
    mongo = aws_security_group.mongo.id
    api   = aws_security_group.api.id
  }

  security_group_id = each.value
  cidr_ipv4         = aws_vpc.agent.cidr_block
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  description       = "In-VPC DNS resolution"
}

resource "aws_vpc_security_group_egress_rule" "dns_tcp" {
  for_each = {
    mongo = aws_security_group.mongo.id
    api   = aws_security_group.api.id
  }

  security_group_id = each.value
  cidr_ipv4         = aws_vpc.agent.cidr_block
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  description       = "In-VPC DNS resolution"
}

resource "aws_vpc_security_group_egress_rule" "s3_endpoint" {
  for_each = {
    mongo = aws_security_group.mongo.id
    api   = aws_security_group.api.id
  }

  security_group_id = each.value
  prefix_list_id    = data.aws_prefix_list.s3.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "Versioned object custody via the S3 gateway endpoint"
}

# ── VPC endpoints ─────────────────────────────────────────────────────────────

data "aws_prefix_list" "s3" {
  name = "com.amazonaws.${local.region}.s3"
}

locals {
  interface_endpoint_services = [
    "ecr.api", "ecr.dkr", "logs", "secretsmanager", "kms",
    "ssm", "ssmmessages", "ec2messages",
    "ec2", "ecs", "ecs-agent", "ecs-telemetry",
  ]
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(local.interface_endpoint_services)

  vpc_id              = aws_vpc.agent.id
  service_name        = "com.amazonaws.${local.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for subnet in aws_subnet.private : subnet.id]
  security_group_ids  = [aws_security_group.endpoints.id]

  tags = merge(local.runtime_tags, { Name = "stokd-agent-${var.stage}-${each.key}" })
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.agent.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for table in aws_route_table.private : table.id]

  tags = merge(local.runtime_tags, { Name = "stokd-agent-${var.stage}-s3" })
}
