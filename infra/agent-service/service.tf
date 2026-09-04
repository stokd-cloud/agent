resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "Agent API task"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

# Outbound only: Atlas, ECR, CloudWatch, Secrets Manager. There is no NAT in
# this VPC, so the task runs in a public subnet and egresses via the IGW.
resource "aws_vpc_security_group_egress_rule" "api_all" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Atlas, ECR, logs, secrets"
}

resource "aws_vpc_security_group_ingress_rule" "api_http" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 8080
  to_port           = 8080
  description       = "Agent API"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/selfactor/agents/api"
  retention_in_days = 14
  tags              = local.tags
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The one secret the task is allowed to read. Not a wildcard.
resource "aws_iam_role_policy" "execution_secret" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = var.mongo_secret_arn
    }]
  })
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.tags
}

resource "aws_ecs_task_definition" "api" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = local.tags

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.api_image
    essential = true

    portMappings = [{ containerPort = 8080, protocol = "tcp" }]

    environment = [
      { name = "AGENT_STAGE", value = "selfactor" },
      { name = "AGENT_DATABASE_NAME", value = var.database_name },
      { name = "AGENT_RECOVERY_MODE", value = "active" },
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "8080" },
    ]

    secrets = [
      { name = "AGENT_MONGO_URI", valueFrom = var.mongo_secret_arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = local.name
  cluster         = local.cluster_arn
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  tags            = local.tags

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = true
  }

  dynamic "load_balancer" {
    for_each = var.create_alb ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.api[0].arn
      container_name   = "api"
      container_port   = 8080
    }
  }

  depends_on = [aws_lb_listener.http]
}

output "cluster_arn" { value = local.cluster_arn }
output "service_name" { value = aws_ecs_service.api.name }
output "log_group" { value = aws_cloudwatch_log_group.api.name }
