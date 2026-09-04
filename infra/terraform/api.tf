# ── API service ───────────────────────────────────────────────────────────────
# Stateless Fargate tasks behind a public TLS load balancer. The tasks hold no
# state and run no model loop; every provider invocation happens on an enrolled
# user machine with that machine's own credentials.

resource "aws_ecs_cluster" "api" {
  name = local.cluster_name
  tags = local.runtime_tags
}

# Registered to match the validated cluster topology. The service pins
# launch_type FARGATE, so availability of FARGATE_SPOT does not place anything
# on spot capacity.
resource "aws_ecs_cluster_capacity_providers" "api" {
  cluster_name       = aws_ecs_cluster.api.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

# The retained exact-SAN certificate is provisioned once and referenced by ARN,
# so a stage rebuild never re-issues it.
data "aws_ssm_parameter" "certificate" {
  name = local.certificate_param
}

resource "terraform_data" "certificate_guard" {
  input = data.aws_ssm_parameter.certificate.value

  lifecycle {
    precondition {
      condition     = can(regex("^arn:aws:acm:us-east-1:167217327520:certificate/[a-f0-9-]{36}$", data.aws_ssm_parameter.certificate.value))
      error_message = "retained exact-SAN certificate parameter is invalid."
    }
  }
}

# ── Load balancer edge ────────────────────────────────────────────────────────
# The ALB group accepts public 80/443 and may egress to exactly one place: the
# API task group on 8080. There is no general egress rule.

resource "aws_security_group" "alb" {
  name        = "stokd-agent-alb-exact-${var.stage}"
  description = "Exact public TLS load balancer; egress only to the Agent API task group"
  vpc_id      = aws_vpc.agent.id
  tags        = local.stateless_tags
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "HTTP redirect"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "Exact ALB to Agent API task group"
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "Only the exact Agent ALB security group may reach API tasks"
}

resource "aws_lb" "api" {
  name                       = "agent-${var.stage}"
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = [for subnet in aws_subnet.public : subnet.id]
  idle_timeout               = 3600
  enable_deletion_protection = false
  tags                       = local.stateless_tags
}

resource "aws_lb_target_group" "api" {
  name                 = "agent-${var.stage}"
  port                 = 8080
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.agent.id
  deregistration_delay = 30

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    interval            = 30
    timeout             = 20
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  tags = local.stateless_tags
}

resource "aws_lb_listener" "redirect" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = data.aws_ssm_parameter.certificate.value

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_route53_record" "api" {
  zone_id = local.hosted_zone_id
  name    = local.domain
  type    = "A"

  alias {
    name                   = aws_lb.api.dns_name
    zone_id                = aws_lb.api.zone_id
    evaluate_target_health = true
  }
}

# ── Task identities ───────────────────────────────────────────────────────────
# Both roles carry the workload permissions boundary. That boundary is an
# allowlist which contains no Bedrock or other model-invoke action, so no policy
# attached here can grant one. The explicit denies below make that provable by
# simulation rather than only by absence.

data "aws_iam_policy_document" "ecs_task_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api_execution" {
  name                 = "stokd-agent-workload-api-${var.stage}-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_task_trust.json
  permissions_boundary = local.boundary_arn
  tags                 = local.stateless_tags
}

data "aws_iam_policy_document" "api_execution" {
  statement {
    sid       = "AuthenticateEcr"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadPinnedImages"
    effect    = "Allow"
    resources = [local.repository_arn]

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
  }

  statement {
    sid       = "WriteExactLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${local.log_group_arn}:*"]
  }

  # Exactly one secret. Not a wildcard over the stage's secrets.
  statement {
    sid       = "OnlyRuntimeSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = [local.runtime_secret_arn]
  }

  statement {
    sid       = "DecryptOnlyStageKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.data.arn]
  }

  statement {
    sid       = "NoModelInvocation"
    effect    = "Deny"
    resources = ["*"]

    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Converse",
      "bedrock:ConverseStream",
    ]
  }
}

resource "aws_iam_role_policy" "api_execution" {
  name   = "stokd-agent-api-${var.stage}-execution"
  role   = aws_iam_role.api_execution.id
  policy = data.aws_iam_policy_document.api_execution.json
}

resource "aws_iam_role" "api_task" {
  name                 = "stokd-agent-workload-api-${var.stage}-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_task_trust.json
  permissions_boundary = local.boundary_arn
  tags                 = local.stateless_tags
}

# The running task needs no AWS control plane at all. It talks to MongoDB and
# S3 through the network, and everything else is denied outright.
data "aws_iam_policy_document" "api_task" {
  statement {
    sid       = "NoAwsControlPlaneAccess"
    effect    = "Deny"
    resources = ["*"]

    actions = [
      "ecs:*",
      "events:*",
      "lambda:InvokeFunction",
      "secretsmanager:*",
      "sns:Publish",
      "sqs:SendMessage",
      "ssm:*",
      "states:StartExecution",
    ]
  }

  statement {
    sid       = "NoModelInvocation"
    effect    = "Deny"
    resources = ["*"]

    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Converse",
      "bedrock:ConverseStream",
    ]
  }
}

resource "aws_iam_role_policy" "api_task" {
  name   = "stokd-agent-api-${var.stage}-task"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task.json
}

# ── Service ───────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "api" {
  name              = local.log_group_name
  retention_in_days = 30
  tags              = local.stateless_tags
}

resource "aws_ecs_task_definition" "api" {
  family                   = "stokd-agent-api-${var.stage}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.api_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn
  tags                     = local.stateless_tags

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.api_image
    essential = true

    portMappings = [{
      containerPort = 8080
      protocol      = "tcp"
    }]

    environment = [
      { name = "AGENT_STAGE", value = var.stage },
      { name = "AGENT_DATABASE_NAME", value = local.database_name },
      { name = "AGENT_MONGO_HOST", value = local.mongo_service_dns },
      { name = "AGENT_REPLICA_SET", value = local.replica_set },
      { name = "AGENT_RECOVERY_MODE", value = local.recovery_mode },
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "8080" },
    ]

    # The only secret the task receives, injected by the execution role.
    secrets = [
      { name = "AGENT_RUNTIME_SECRET_VALUE", valueFrom = local.runtime_secret_arn },
    ]

    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      startPeriod = 90
      interval    = 30
      timeout     = 20
      retries     = 3
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = local.log_group_name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = local.api_service_name
  cluster         = aws_ecs_cluster.api.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  propagate_tags  = "SERVICE"

  # Exec is off: a shell into a task would bypass the authority boundary this
  # item exists to prove.
  enable_execute_command = false
  wait_for_steady_state  = true

  network_configuration {
    subnets          = [for subnet in aws_subnet.private : subnet.id]
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }

  tags = local.stateless_tags

  depends_on = [
    aws_lb_listener.https,
    aws_vpc_security_group_egress_rule.alb_to_api,
    aws_vpc_security_group_ingress_rule.api_from_alb,
  ]
}
