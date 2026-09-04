# A stable address for the service. Optional: without it the task is reachable
# only at whatever public IP Fargate hands it, which changes on every restart.
variable "create_alb" {
  type    = bool
  default = false
}

resource "aws_security_group" "alb" {
  count       = var.create_alb ? 1 : 0
  name        = "${local.name}-alb"
  description = "Agent API load balancer"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  count             = var.create_alb ? 1 : 0
  security_group_id = aws_security_group.alb[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  count                        = var.create_alb ? 1 : 0
  security_group_id            = aws_security_group.alb[0].id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}

resource "aws_lb" "api" {
  count              = var.create_alb ? 1 : 0
  name               = local.name
  load_balancer_type = "application"
  subnets            = var.subnet_ids
  security_groups    = [aws_security_group.alb[0].id]
  tags               = local.tags
}

resource "aws_lb_target_group" "api" {
  count       = var.create_alb ? 1 : 0
  name        = local.name
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  tags        = local.tags

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  count             = var.create_alb ? 1 : 0
  load_balancer_arn = aws_lb.api[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api[0].arn
  }
}

output "api_url" {
  value = var.create_alb ? "http://${aws_lb.api[0].dns_name}" : "no alb; use the task public IP"
}
