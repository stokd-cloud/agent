#!/usr/bin/env python3
"""Stokd multi-profile AWS cost analysis toolkit.

Read-only Cost Explorer + inventory scans. Writes snapshots/reports under
~/.stokd/cost-analysis/ and optional per-profile LaunchAgents for recurrence.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import subprocess
import sys
import traceback
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

HOME = Path.home()
ROOT = HOME / ".stokd" / "cost-analysis"
CONFIG_PATH = ROOT / "config.json"
SNAPSHOTS = ROOT / "snapshots"
REPORTS = ROOT / "reports"
LOGS = ROOT / "logs"
LAUNCH_AGENTS = HOME / "Library" / "LaunchAgents"
SCRIPT_PATH = Path(__file__).resolve()

# Services treated as mostly always-on / floor
FIXED_SERVICE_HINTS = (
    "Elastic Load Balancing",
    "Virtual Private Cloud",
    "ElastiCache",
    "Elastic Container Service",
    "AWS WAF",
    "Route 53",
    "Secrets Manager",
    "Elastic Compute Cloud - Compute",
    "EC2 - Other",
    "Relational Database Service",
    "OpenSearch",
    "Elasticsearch",
    "Redshift",
    "DocumentDB",
    "Neptune",
    "MemoryDB",
    "Fargate",
)

VARIABLE_SERVICE_HINTS = (
    "Lambda",
    "API Gateway",
    "Bedrock",
    "Claude",
    "CloudWatch",
    "Simple Storage Service",
    "Data Transfer",
    "SageMaker",
    "Glue",
    "Athena",
    "EMR",
    "Batch",
    "ECS",  # can be either; still track under variable when spiky
)

LEGACY_INSTANCE_PREFIXES = (
    "m4.",
    "m3.",
    "c4.",
    "c3.",
    "r4.",
    "r3.",
    "t2.",
    "i3.",
    "i2.",
    "g3.",
    "p2.",
    "p3.",
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def today() -> date:
    return date.today()


def ensure_dirs() -> None:
    for p in (ROOT, SNAPSHOTS, REPORTS, LOGS):
        p.mkdir(parents=True, exist_ok=True)


def load_config() -> dict[str, Any]:
    ensure_dirs()
    if not CONFIG_PATH.is_file():
        return {
            "version": 1,
            "forecast_min_snapshots": 4,
            "default_lookback_days": 30,
            "profiles": {},
        }
    with CONFIG_PATH.open() as f:
        cfg = json.load(f)
    cfg.setdefault("version", 1)
    cfg.setdefault("forecast_min_snapshots", 4)
    cfg.setdefault("default_lookback_days", 30)
    cfg.setdefault("profiles", {})
    return cfg


def save_config(cfg: dict[str, Any]) -> None:
    ensure_dirs()
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CONFIG_PATH.open("w") as f:
        json.dump(cfg, f, indent=2, sort_keys=True)
        f.write("\n")


def run_aws(
    profile: str,
    args: list[str],
    region: str | None = None,
    timeout: int = 120,
) -> tuple[int, Any, str]:
    env = os.environ.copy()
    env["AWS_PROFILE"] = profile
    env["AWS_DEFAULT_PROFILE"] = profile
    if region:
        env["AWS_DEFAULT_REGION"] = region
        env["AWS_REGION"] = region
    cmd = ["aws", *args, "--output", "json"]
    try:
        proc = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        return 127, None, "aws CLI not found"
    except subprocess.TimeoutExpired:
        return 124, None, f"timeout after {timeout}s: {' '.join(cmd)}"
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        return proc.returncode, None, err or proc.stdout
    out = (proc.stdout or "").strip()
    if not out:
        return 0, None, err
    try:
        return 0, json.loads(out), err
    except json.JSONDecodeError:
        return 0, out, err


def list_profiles() -> list[str]:
    try:
        proc = subprocess.run(
            ["aws", "configure", "list-profiles"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception as e:
        print(f"error listing profiles: {e}", file=sys.stderr)
        return []
    return [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]


def identity_for(profile: str) -> dict[str, Any]:
    code, data, err = run_aws(profile, ["sts", "get-caller-identity"])
    if code != 0 or not isinstance(data, dict):
        return {"ok": False, "error": err or "sts failed", "profile": profile}
    return {
        "ok": True,
        "profile": profile,
        "account": data.get("Account"),
        "arn": data.get("Arn"),
        "user_id": data.get("UserId"),
    }


def cmd_list_profiles(_: argparse.Namespace) -> int:
    profiles = list_profiles()
    rows = []
    for p in profiles:
        ident = identity_for(p)
        rows.append(ident)
        if ident.get("ok"):
            print(f"OK   {p:24} account={ident.get('account')}  arn={ident.get('arn')}")
        else:
            print(f"FAIL {p:24} {ident.get('error', '')[:120]}")
    print(json.dumps({"profiles": rows}, indent=2))
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    cfg = load_config()
    print(json.dumps(cfg, indent=2))
    print(f"\nconfig_path={CONFIG_PATH}")
    for name, pcfg in cfg.get("profiles", {}).items():
        snap_dir = SNAPSHOTS / _safe(name)
        n = len(list(snap_dir.glob("*.json"))) if snap_dir.is_dir() else 0
        print(
            f"  profile={name} enabled={pcfg.get('enabled')} "
            f"schedule={pcfg.get('schedule')} snapshots={n} "
            f"budget_monthly={pcfg.get('budget_monthly')}"
        )
    return 0


def _safe(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in name)


def cmd_configure(args: argparse.Namespace) -> int:
    cfg = load_config()
    if args.from_file:
        with open(args.from_file) as f:
            incoming = json.load(f)
        if "profiles" in incoming or "forecast_min_snapshots" in incoming:
            # full or partial config merge
            if "forecast_min_snapshots" in incoming:
                cfg["forecast_min_snapshots"] = int(incoming["forecast_min_snapshots"])
            if "default_lookback_days" in incoming:
                cfg["default_lookback_days"] = int(incoming["default_lookback_days"])
            for name, pcfg in (incoming.get("profiles") or {}).items():
                cur = cfg["profiles"].get(name, {})
                cur.update(pcfg)
                cur.setdefault("enabled", True)
                cur.setdefault("schedule", "none")
                cfg["profiles"][name] = cur
        else:
            print("from-file must include profiles and/or global keys", file=sys.stderr)
            return 2
    elif args.set_json:
        incoming = json.loads(args.set_json)
        if "forecast_min_snapshots" in incoming:
            cfg["forecast_min_snapshots"] = int(incoming["forecast_min_snapshots"])
        for name, pcfg in (incoming.get("profiles") or {}).items():
            cur = cfg["profiles"].get(name, {})
            cur.update(pcfg)
            cfg["profiles"][name] = cur
    elif args.profile:
        name = args.profile
        cur = cfg["profiles"].get(name, {})
        if args.enable is not None:
            cur["enabled"] = bool(args.enable)
        if args.schedule:
            cur["schedule"] = args.schedule
        if args.budget_monthly is not None:
            cur["budget_monthly"] = args.budget_monthly
        if args.budget_quarterly is not None:
            cur["budget_quarterly"] = args.budget_quarterly
        if args.label:
            cur["label"] = args.label
        if args.region:
            cur["region"] = args.region
        cur.setdefault("enabled", True)
        cur.setdefault("schedule", "none")
        cfg["profiles"][name] = cur
    else:
        print(
            "configure requires --from-file, --set-json, or --profile flags",
            file=sys.stderr,
        )
        return 2

    if args.forecast_min_snapshots is not None:
        cfg["forecast_min_snapshots"] = int(args.forecast_min_snapshots)

    save_config(cfg)

    # Align schedules with config when requested
    if args.apply_schedules:
        for name, pcfg in cfg["profiles"].items():
            if not pcfg.get("enabled"):
                schedule_remove(name)
                continue
            sch = (pcfg.get("schedule") or "none").lower()
            if sch in ("daily", "weekly"):
                schedule_install(name, sch)
            else:
                schedule_remove(name)

    print(f"wrote {CONFIG_PATH}")
    print(json.dumps(cfg, indent=2))
    return 0


def ce_usage_by_service(
    profile: str, start: str, end: str, granularity: str = "MONTHLY"
) -> list[dict[str, Any]]:
    filt = json.dumps({"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}})
    code, data, err = run_aws(
        profile,
        [
            "ce",
            "get-cost-and-usage",
            "--time-period",
            f"Start={start},End={end}",
            "--granularity",
            granularity,
            "--metrics",
            "UnblendedCost",
            "--filter",
            filt,
            "--group-by",
            "Type=DIMENSION,Key=SERVICE",
        ],
        timeout=180,
    )
    if code != 0 or not isinstance(data, dict):
        return [{"error": err or "ce failed"}]
    out = []
    for period in data.get("ResultsByTime", []):
        tp = period.get("TimePeriod", {})
        services = []
        total = 0.0
        for g in period.get("Groups", []):
            amt = float(g["Metrics"]["UnblendedCost"]["Amount"])
            total += amt
            services.append({"service": g["Keys"][0], "amount": amt})
        services.sort(key=lambda x: -x["amount"])
        out.append(
            {
                "start": tp.get("Start"),
                "end": tp.get("End"),
                "total": total,
                "services": services,
                "estimated": period.get("Estimated"),
            }
        )
    return out


def ce_daily_usage(profile: str, start: str, end: str) -> list[dict[str, Any]]:
    filt = json.dumps({"Dimensions": {"Key": "RECORD_TYPE", "Values": ["Usage"]}})
    code, data, err = run_aws(
        profile,
        [
            "ce",
            "get-cost-and-usage",
            "--time-period",
            f"Start={start},End={end}",
            "--granularity",
            "DAILY",
            "--metrics",
            "UnblendedCost",
            "--filter",
            filt,
        ],
        timeout=180,
    )
    if code != 0 or not isinstance(data, dict):
        return [{"error": err or "ce daily failed"}]
    rows = []
    for period in data.get("ResultsByTime", []):
        amt = float(period["Total"]["UnblendedCost"]["Amount"])
        rows.append(
            {
                "date": period["TimePeriod"]["Start"],
                "usage": amt,
                "estimated": period.get("Estimated"),
            }
        )
    return rows


def ce_record_types(profile: str, start: str, end: str) -> list[dict[str, Any]]:
    code, data, err = run_aws(
        profile,
        [
            "ce",
            "get-cost-and-usage",
            "--time-period",
            f"Start={start},End={end}",
            "--granularity",
            "MONTHLY",
            "--metrics",
            "UnblendedCost",
            "--group-by",
            "Type=DIMENSION,Key=RECORD_TYPE",
        ],
    )
    if code != 0 or not isinstance(data, dict):
        return [{"error": err or "ce record types failed"}]
    out = []
    for period in data.get("ResultsByTime", []):
        rows = []
        for g in period.get("Groups", []):
            rows.append(
                {
                    "type": g["Keys"][0],
                    "amount": float(g["Metrics"]["UnblendedCost"]["Amount"]),
                }
            )
        out.append({"start": period["TimePeriod"]["Start"], "rows": rows})
    return out


def classify_service(name: str) -> str:
    for h in FIXED_SERVICE_HINTS:
        if h.lower() in name.lower():
            return "fixed"
    for h in VARIABLE_SERVICE_HINTS:
        if h.lower() in name.lower():
            return "variable"
    return "other"


def inventory_waste(profile: str, region: str | None) -> dict[str, Any]:
    findings: list[dict[str, Any]] = []
    meta: dict[str, Any] = {"region": region}

    # Unattached EBS
    code, data, err = run_aws(
        profile,
        ["ec2", "describe-volumes", "--filters", "Name=status,Values=available"],
        region=region,
    )
    if code == 0 and isinstance(data, dict):
        vols = data.get("Volumes", [])
        for v in vols:
            findings.append(
                {
                    "category": "waste",
                    "kind": "unattached_ebs",
                    "id": v.get("VolumeId"),
                    "size_gb": v.get("Size"),
                    "type": v.get("VolumeType"),
                    "action": "Delete or attach; unattached EBS still bills",
                    "impact": "medium",
                }
            )
        meta["unattached_ebs"] = len(vols)
    else:
        meta["unattached_ebs_error"] = err

    # EIPs
    code, data, err = run_aws(profile, ["ec2", "describe-addresses"], region=region)
    if code == 0 and isinstance(data, dict):
        unassoc = [
            a
            for a in data.get("Addresses", [])
            if not a.get("AssociationId") and not a.get("InstanceId")
        ]
        for a in unassoc:
            findings.append(
                {
                    "category": "waste",
                    "kind": "unassociated_eip",
                    "id": a.get("AllocationId") or a.get("PublicIp"),
                    "public_ip": a.get("PublicIp"),
                    "action": "Release unassociated Elastic IP",
                    "impact": "low",
                }
            )
        meta["unassociated_eips"] = len(unassoc)
    else:
        meta["eip_error"] = err

    # EC2 instances + legacy families
    code, data, err = run_aws(
        profile,
        [
            "ec2",
            "describe-instances",
            "--filters",
            "Name=instance-state-name,Values=running",
        ],
        region=region,
    )
    if code == 0 and isinstance(data, dict):
        running = []
        for res in data.get("Reservations", []):
            for inst in res.get("Instances", []):
                itype = inst.get("InstanceType") or ""
                name = None
                for t in inst.get("Tags") or []:
                    if t.get("Key") == "Name":
                        name = t.get("Value")
                running.append(
                    {
                        "id": inst.get("InstanceId"),
                        "type": itype,
                        "name": name,
                        "az": (inst.get("Placement") or {}).get("AvailabilityZone"),
                    }
                )
                if any(itype.startswith(p) for p in LEGACY_INSTANCE_PREFIXES):
                    findings.append(
                        {
                            "category": "sizing",
                            "kind": "legacy_instance_family",
                            "id": inst.get("InstanceId"),
                            "type": itype,
                            "name": name,
                            "action": "Evaluate modern/Graviton generation for 20–40% better cost/perf",
                            "impact": "medium",
                        }
                    )
                lname = (name or "").lower()
                if any(k in lname for k in ("stage", "staging", "dev", "test", "sandbox")):
                    findings.append(
                        {
                            "category": "waste",
                            "kind": "nonprod_always_on",
                            "id": inst.get("InstanceId"),
                            "name": name,
                            "type": itype,
                            "action": "Consider schedule stop nights/weekends for non-prod",
                            "impact": "medium",
                        }
                    )
        meta["running_instances"] = running
    else:
        meta["ec2_error"] = err

    # Load balancers
    code, data, err = run_aws(profile, ["elbv2", "describe-load-balancers"], region=region)
    if code == 0 and isinstance(data, dict):
        lbs = data.get("LoadBalancers", [])
        meta["load_balancers"] = [
            {
                "name": lb.get("LoadBalancerName"),
                "arn": lb.get("LoadBalancerArn"),
                "type": lb.get("Type"),
                "state": (lb.get("State") or {}).get("Code"),
            }
            for lb in lbs
        ]
        # Idle heuristic: ALB present + zero ECS tasks later
        for lb in lbs:
            findings.append(
                {
                    "category": "governance",
                    "kind": "load_balancer_present",
                    "id": lb.get("LoadBalancerName"),
                    "type": lb.get("Type"),
                    "action": "Verify traffic; idle ALB/NLB still ~$16+/mo each",
                    "impact": "medium",
                }
            )
    else:
        meta["elb_error"] = err

    # NAT gateways
    code, data, err = run_aws(
        profile,
        ["ec2", "describe-nat-gateways", "--filter", "Name=state,Values=available"],
        region=region,
    )
    if code == 0 and isinstance(data, dict):
        nats = data.get("NatGateways", [])
        meta["nat_gateways"] = len(nats)
        for n in nats:
            findings.append(
                {
                    "category": "architecture",
                    "kind": "nat_gateway",
                    "id": n.get("NatGatewayId"),
                    "action": "NAT Gateway is a top fixed cost; confirm need vs NAT instance/PrivateLink",
                    "impact": "high",
                }
            )
    else:
        meta["nat_error"] = err

    # CloudWatch log groups by size
    code, data, err = run_aws(profile, ["logs", "describe-log-groups"], region=region, timeout=180)
    if code == 0 and isinstance(data, dict):
        groups = sorted(
            data.get("logGroups", []),
            key=lambda g: g.get("storedBytes") or 0,
            reverse=True,
        )
        total = sum(g.get("storedBytes") or 0 for g in groups)
        meta["log_storage_bytes"] = total
        meta["log_groups_top"] = [
            {
                "name": g.get("logGroupName"),
                "bytes": g.get("storedBytes") or 0,
                "retention": g.get("retentionInDays"),
            }
            for g in groups[:15]
        ]
        if total > 2_000_000_000:
            findings.append(
                {
                    "category": "waste",
                    "kind": "cloudwatch_log_bloat",
                    "bytes": total,
                    "action": "Tighten retention / reduce chatty agents; logs ingest+storage add up",
                    "impact": "medium",
                }
            )
        for g in groups[:5]:
            b = g.get("storedBytes") or 0
            if b > 500_000_000 and not g.get("retentionInDays"):
                findings.append(
                    {
                        "category": "waste",
                        "kind": "log_group_no_retention",
                        "id": g.get("logGroupName"),
                        "bytes": b,
                        "action": "Set retention (e.g. 14–30d) on large log groups",
                        "impact": "medium",
                    }
                )
    else:
        meta["logs_error"] = err

    # ECS services desired vs running
    code, data, err = run_aws(profile, ["ecs", "list-clusters"], region=region)
    if code == 0 and isinstance(data, dict):
        ecs_info = []
        for carm in data.get("clusterArns") or []:
            c2, d2, e2 = run_aws(
                profile, ["ecs", "list-services", "--cluster", carm], region=region
            )
            if c2 != 0 or not isinstance(d2, dict):
                continue
            sarns = d2.get("serviceArns") or []
            if not sarns:
                ecs_info.append({"cluster": carm, "services": []})
                continue
            # describe in chunks of 10
            services = []
            for i in range(0, len(sarns), 10):
                chunk = sarns[i : i + 10]
                c3, d3, _ = run_aws(
                    profile,
                    [
                        "ecs",
                        "describe-services",
                        "--cluster",
                        carm,
                        "--services",
                        *chunk,
                    ],
                    region=region,
                )
                if c3 == 0 and isinstance(d3, dict):
                    for s in d3.get("services") or []:
                        services.append(
                            {
                                "name": s.get("serviceName"),
                                "desired": s.get("desiredCount"),
                                "running": s.get("runningCount"),
                            }
                        )
                        if (s.get("desiredCount") or 0) > 0 and (s.get("runningCount") or 0) == 0:
                            findings.append(
                                {
                                    "category": "waste",
                                    "kind": "ecs_desired_but_not_running",
                                    "id": s.get("serviceName"),
                                    "cluster": carm,
                                    "action": "Service desired>0 but running=0 — still may drive ALB cost",
                                    "impact": "medium",
                                }
                            )
            ecs_info.append({"cluster": carm, "services": services})
        meta["ecs"] = ecs_info
    else:
        meta["ecs_error"] = err

    # Savings plans utilization (best effort)
    end = today()
    start = end - timedelta(days=30)
    code, data, err = run_aws(
        profile,
        [
            "ce",
            "get-savings-plans-utilization",
            "--time-period",
            f"Start={start.isoformat()},End={end.isoformat()}",
        ],
    )
    if code == 0 and isinstance(data, dict):
        meta["savings_plans"] = data.get("Total") or data
    else:
        meta["savings_plans_error"] = err

    # RI utilization summary best effort
    code, data, err = run_aws(
        profile,
        [
            "ce",
            "get-reservation-utilization",
            "--time-period",
            f"Start={start.isoformat()},End={end.isoformat()}",
        ],
    )
    if code == 0 and isinstance(data, dict):
        meta["reservation_utilization"] = data.get("Total") or {
            "periods": len(data.get("UtilizationsByTime") or [])
        }
    else:
        meta["reservation_error"] = err

    return {"findings": findings, "meta": meta}


def build_snapshot(profile: str, lookback_days: int, region: str | None) -> dict[str, Any]:
    end = today() + timedelta(days=1)  # CE end exclusive-ish; use tomorrow
    # CE End is exclusive
    end_s = end.isoformat()
    start_month = (today().replace(day=1)).isoformat()
    start_lookback = (today() - timedelta(days=lookback_days)).isoformat()
    start_3m = (today() - timedelta(days=90)).isoformat()

    ident = identity_for(profile)
    monthly = ce_usage_by_service(profile, start_3m, end_s, "MONTHLY")
    daily = ce_daily_usage(profile, start_lookback, end_s)
    records = ce_record_types(profile, start_month, end_s)
    inv = inventory_waste(profile, region)

    # Latest monthly totals
    latest_month = monthly[-1] if monthly and "total" in monthly[-1] else None
    services = (latest_month or {}).get("services") or []
    fixed = sum(s["amount"] for s in services if classify_service(s["service"]) == "fixed")
    variable = sum(s["amount"] for s in services if classify_service(s["service"]) == "variable")
    other = sum(s["amount"] for s in services if classify_service(s["service"]) == "other")

    daily_ok = [d for d in daily if "usage" in d]
    avg_daily = (
        sum(d["usage"] for d in daily_ok) / len(daily_ok) if daily_ok else 0.0
    )
    last7 = daily_ok[-7:] if len(daily_ok) >= 7 else daily_ok
    avg7 = sum(d["usage"] for d in last7) / len(last7) if last7 else avg_daily

    # WoW velocity on daily totals
    wow = None
    if len(daily_ok) >= 14:
        prev = sum(d["usage"] for d in daily_ok[-14:-7]) / 7
        cur = sum(d["usage"] for d in daily_ok[-7:]) / 7
        wow = {
            "prev_avg_daily": prev,
            "cur_avg_daily": cur,
            "delta": cur - prev,
            "pct": ((cur - prev) / prev * 100.0) if prev else None,
        }

    snap = {
        "version": 1,
        "ts": utc_now().isoformat(),
        "profile": profile,
        "identity": ident,
        "lookback_days": lookback_days,
        "region": region,
        "ce": {
            "monthly_usage_by_service": monthly,
            "daily_usage": daily_ok,
            "record_types_mtd": records,
        },
        "summary": {
            "avg_daily_lookback": avg_daily,
            "avg_daily_7d": avg7,
            "monthly_pace_from_7d": avg7 * 30,
            "annual_pace_from_7d": avg7 * 365,
            "fixed_mtd_or_latest": fixed,
            "variable_mtd_or_latest": variable,
            "other_mtd_or_latest": other,
            "wow": wow,
            "top_services": services[:15],
        },
        "inventory": inv,
    }
    return snap


def linear_regression(xs: list[float], ys: list[float]) -> tuple[float, float]:
    """Return slope, intercept for y = slope*x + intercept."""
    n = len(xs)
    if n < 2:
        return 0.0, ys[0] if ys else 0.0
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    den = sum((x - mean_x) ** 2 for x in xs) or 1.0
    slope = num / den
    intercept = mean_y - slope * mean_x
    return slope, intercept


def percentile(vals: list[float], p: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] * (c - k) + s[c] * (k - f)


def load_snapshots(profile: str) -> list[dict[str, Any]]:
    d = SNAPSHOTS / _safe(profile)
    if not d.is_dir():
        return []
    out = []
    for path in sorted(d.glob("*.json")):
        try:
            with path.open() as f:
                out.append(json.load(f))
        except Exception:
            continue
    return out


def compute_trends(
    profile: str, min_snapshots: int, budget_monthly: float | None, budget_quarterly: float | None
) -> dict[str, Any]:
    snaps = load_snapshots(profile)
    n = len(snaps)
    result: dict[str, Any] = {
        "profile": profile,
        "snapshot_count": n,
        "min_required": min_snapshots,
        "ready": n >= min_snapshots,
    }
    if n < 2:
        result["message"] = f"Need at least 2 snapshots (have {n})"
        result["complete_suite"] = False
        return result

    # Series of avg_daily_7d
    series = []
    for s in snaps:
        summary = s.get("summary") or {}
        series.append(
            {
                "ts": s.get("ts"),
                "avg7": float(summary.get("avg_daily_7d") or 0),
                "pace_mo": float(summary.get("monthly_pace_from_7d") or 0),
                "top": summary.get("top_services") or [],
                "fixed": float(summary.get("fixed_mtd_or_latest") or 0),
                "variable": float(summary.get("variable_mtd_or_latest") or 0),
            }
        )

    ys = [p["avg7"] for p in series]
    xs = list(range(len(ys)))
    slope, intercept = linear_regression([float(x) for x in xs], ys)

    # Project 12 months assuming snapshots ~ weekly → scale slope per step
    # Use per-snapshot step as one unit; annualize by assuming weekly cadence if schedule weekly
    last = ys[-1]
    # Project forward 12 steps and 52 steps
    proj_12_steps = intercept + slope * (len(ys) - 1 + 12)
    annual_now = last * 365
    # If slope is per snapshot, estimate snapshot interval from timestamps
    interval_days = 7.0
    if len(series) >= 2:
        try:
            t0 = datetime.fromisoformat(series[0]["ts"].replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(series[-1]["ts"].replace("Z", "+00:00"))
            interval_days = max(1.0, (t1 - t0).total_seconds() / 86400 / (len(series) - 1))
        except Exception:
            pass
    daily_slope = slope / interval_days  # change in avg_daily per calendar day
    avg_daily_in_365d = last + daily_slope * 365
    annual_in_365d = max(0.0, avg_daily_in_365d) * 365

    # Velocity: delta-of-delta on avg7
    deltas = [ys[i] - ys[i - 1] for i in range(1, len(ys))]
    accel = None
    if len(deltas) >= 2:
        accel = deltas[-1] - deltas[-2]

    # Per-service acceleration using last vs previous snapshot top maps
    service_vel = []
    if len(snaps) >= 2:
        def svc_map(s: dict) -> dict[str, float]:
            m = {}
            for row in (s.get("summary") or {}).get("top_services") or []:
                m[row["service"]] = float(row["amount"])
            return m

        maps = [svc_map(s) for s in snaps[-3:]]
        keys = set()
        for m in maps:
            keys |= set(m)
        if len(maps) >= 2:
            for k in keys:
                vals = [m.get(k, 0.0) for m in maps]
                d1 = vals[-1] - vals[-2]
                d0 = vals[-2] - vals[-3] if len(vals) >= 3 else 0.0
                service_vel.append(
                    {
                        "service": k,
                        "latest": vals[-1],
                        "delta": d1,
                        "acceleration": d1 - d0,
                    }
                )
            service_vel.sort(key=lambda r: -abs(r["acceleration"]))

    # Baseline vs variable trajectory
    fixed_s = [p["fixed"] for p in series]
    var_s = [p["variable"] for p in series]
    f_slope, _ = linear_regression([float(i) for i in range(len(fixed_s))], fixed_s)
    v_slope, _ = linear_regression([float(i) for i in range(len(var_s))], var_s)

    # Storage-ish services growth
    storage_keys = ("Simple Storage", "EC2 - Other", "Glacier", "Backup")
    storage_series = []
    for s in snaps:
        total_st = 0.0
        for row in (s.get("summary") or {}).get("top_services") or []:
            if any(k.lower() in row["service"].lower() for k in storage_keys):
                total_st += float(row["amount"])
        storage_series.append(total_st)
    st_slope, st_int = linear_regression(
        [float(i) for i in range(len(storage_series))], storage_series
    )

    # Data transfer
    xfer_series = []
    for s in snaps:
        total_x = 0.0
        for row in (s.get("summary") or {}).get("top_services") or []:
            if "data transfer" in row["service"].lower() or "vpc" in row["service"].lower():
                total_x += float(row["amount"])
        xfer_series.append(total_x)
    x_slope, _ = linear_regression([float(i) for i in range(len(xfer_series))], xfer_series)

    # Budget breach horizon
    breach = {}
    if budget_monthly and last > 0:
        # days into month
        dim = today().day
        mtd_est = last * dim
        # if pace continues, when monthly budget crossed this month
        if last > 0:
            days_to_budget = budget_monthly / last
            breach_date = today().replace(day=1) + timedelta(days=days_to_budget - 1)
            breach["monthly"] = {
                "budget": budget_monthly,
                "avg_daily": last,
                "days_to_exhaust_budget": days_to_budget,
                "projected_cross_date": breach_date.isoformat(),
                "mtd_est": mtd_est,
                "month_end_pace": last * 30,
            }
    if budget_quarterly and last > 0:
        breach["quarterly"] = {
            "budget": budget_quarterly,
            "days_to_exhaust": budget_quarterly / last,
            "projected_cross_date": (today() + timedelta(days=budget_quarterly / last)).isoformat(),
        }

    # Statistical banding on avg7
    bands = {
        "p10": percentile(ys, 0.10),
        "p50": percentile(ys, 0.50),
        "p90": percentile(ys, 0.90),
        "mean": statistics.mean(ys),
        "stdev": statistics.pstdev(ys) if len(ys) > 1 else 0.0,
    }

    # Category drift: top service shares first vs last
    def shares(s: dict) -> dict[str, float]:
        top = (s.get("summary") or {}).get("top_services") or []
        tot = sum(float(r["amount"]) for r in top) or 1.0
        return {r["service"]: float(r["amount"]) / tot for r in top}

    drift = []
    if len(snaps) >= 2:
        a, b = shares(snaps[0]), shares(snaps[-1])
        keys = set(a) | set(b)
        for k in keys:
            drift.append(
                {
                    "service": k,
                    "share_first": a.get(k, 0.0),
                    "share_last": b.get(k, 0.0),
                    "delta_pp": (b.get(k, 0.0) - a.get(k, 0.0)) * 100,
                }
            )
        drift.sort(key=lambda r: -abs(r["delta_pp"]))

    result.update(
        {
            "interval_days_est": interval_days,
            "run_rate": {
                "latest_avg_daily": last,
                "monthly_pace": last * 30,
                "annual_pace_now": annual_now,
                "annual_pace_in_365d_if_slope_holds": annual_in_365d,
                "snapshot_slope_avg_daily": slope,
                "daily_slope_avg_daily": daily_slope,
                "message": (
                    f"Based on the last {n} snapshots, annual cloud run-rate is pacing "
                    f"from ~${annual_now:,.0f}/yr toward ~${annual_in_365d:,.0f}/yr if the "
                    f"recent slope holds."
                ),
            },
            "velocity": {
                "deltas": deltas,
                "acceleration_last": accel,
                "wow_style_note": "Positive acceleration means spend is speeding up between snapshots",
                "services_by_acceleration": service_vel[:15],
            },
            "baseline_vs_variable": {
                "fixed_latest": fixed_s[-1],
                "variable_latest": var_s[-1],
                "fixed_slope_per_snapshot": f_slope,
                "variable_slope_per_snapshot": v_slope,
            },
            "storage_projection": {
                "series": storage_series,
                "slope_per_snapshot": st_slope,
                "projected_next": st_int + st_slope * len(storage_series),
            },
            "egress_projection": {
                "series": xfer_series,
                "slope_per_snapshot": x_slope,
            },
            "budget_breach_horizon": breach,
            "bands": bands,
            "category_drift": drift[:20],
            "complete_suite": n >= min_snapshots,
        }
    )
    if n < min_snapshots:
        result["message"] = (
            f"Have {n} of {min_snapshots} snapshots — partial trends only; "
            f"full looking-forward suite when N≥{min_snapshots}."
        )
    return result


def render_report(snap: dict[str, Any], trends: dict[str, Any] | None, cfg_profile: dict) -> str:
    lines: list[str] = []
    ident = snap.get("identity") or {}
    summary = snap.get("summary") or {}
    lines.append(f"# AWS Cost Analysis — `{snap.get('profile')}`")
    lines.append("")
    lines.append(f"- **Timestamp:** {snap.get('ts')}")
    lines.append(f"- **Account:** {ident.get('account')} ({ident.get('arn')})")
    lines.append(f"- **Lookback days:** {snap.get('lookback_days')}")
    lines.append("")
    lines.append("## Run-rate (gross Usage)")
    lines.append("")
    lines.append(f"| Metric | Value |")
    lines.append(f"|--------|------:|")
    lines.append(f"| Avg daily (7d) | ${summary.get('avg_daily_7d', 0):,.2f} |")
    lines.append(f"| Monthly pace (×30) | ${summary.get('monthly_pace_from_7d', 0):,.2f} |")
    lines.append(f"| Annual pace (×365) | ${summary.get('annual_pace_from_7d', 0):,.2f} |")
    lines.append(f"| Fixed-ish (latest window services) | ${summary.get('fixed_mtd_or_latest', 0):,.2f} |")
    lines.append(f"| Variable (latest window services) | ${summary.get('variable_mtd_or_latest', 0):,.2f} |")
    wow = summary.get("wow")
    if wow:
        pct = wow.get("pct")
        pct_s = f"{pct:.1f}%" if pct is not None else "n/a"
        lines.append(f"| WoW avg-daily Δ | ${wow.get('delta', 0):,.2f} ({pct_s}) |")
    lines.append("")

    # Record types MTD
    lines.append("## Invoice composition (MTD record types)")
    lines.append("")
    for block in snap.get("ce", {}).get("record_types_mtd") or []:
        if "error" in block:
            lines.append(f"- error: {block['error']}")
            continue
        lines.append(f"Period starting {block.get('start')}:")
        for r in block.get("rows") or []:
            lines.append(f"- **{r['type']}:** ${r['amount']:,.2f}")
    lines.append("")

    lines.append("## Top services (latest monthly Usage bucket)")
    lines.append("")
    for s in (summary.get("top_services") or [])[:12]:
        lines.append(f"- ${s['amount']:,.2f} — {s['service']}")
    lines.append("")

    findings = (snap.get("inventory") or {}).get("findings") or []
    by_cat: dict[str, list] = defaultdict(list)
    for f in findings:
        by_cat[f.get("category") or "other"].append(f)

    title_map = {
        "waste": "1. Direct waste elimination",
        "sizing": "2. Capacity & sizing",
        "commitment": "3. Rate & commitment",
        "governance": "4. Operational & architecture governance",
        "architecture": "4. Operational & architecture governance",
        "strategic": "5. Strategic / unit economics",
    }
    lines.append("## Actionable findings")
    lines.append("")
    if not findings:
        lines.append("_No automated inventory findings (permissions or empty account)._")
    else:
        for cat in ("waste", "sizing", "commitment", "governance", "architecture", "strategic"):
            items = by_cat.get(cat) or []
            if not items:
                continue
            lines.append(f"### {title_map.get(cat, cat)}")
            lines.append("")
            for it in items[:25]:
                lines.append(
                    f"- **{it.get('kind')}** `{it.get('id', '')}` — {it.get('action')} "
                    f"(impact={it.get('impact')})"
                )
            lines.append("")

    inv_meta = (snap.get("inventory") or {}).get("meta") or {}
    if inv_meta.get("log_groups_top"):
        lines.append("### CloudWatch log groups (top)")
        lines.append("")
        for g in inv_meta["log_groups_top"][:8]:
            mb = (g.get("bytes") or 0) / 1e6
            lines.append(
                f"- {mb:,.1f} MB  ret={g.get('retention')}  `{g.get('name')}`"
            )
        lines.append("")

    # Commitments
    if inv_meta.get("savings_plans") or inv_meta.get("savings_plans_error"):
        lines.append("### Commitments (best effort)")
        lines.append("")
        lines.append(f"```json\n{json.dumps(inv_meta.get('savings_plans') or inv_meta.get('savings_plans_error'), indent=2)[:2000]}\n```")
        lines.append("")

    if trends:
        lines.append("## Looking forward")
        lines.append("")
        lines.append(
            f"Snapshots: **{trends.get('snapshot_count')}** "
            f"(suite complete: {trends.get('complete_suite')})"
        )
        if trends.get("message"):
            lines.append(f"_{trends['message']}_")
        rr = trends.get("run_rate") or {}
        if rr:
            lines.append("")
            lines.append("### Run-rate forecast")
            lines.append("")
            lines.append(rr.get("message") or "")
            lines.append(
                f"- Monthly pace now: ${rr.get('monthly_pace', 0):,.2f} · "
                f"Annual now: ${rr.get('annual_pace_now', 0):,.0f} · "
                f"Annual if slope holds 1y: ${rr.get('annual_pace_in_365d_if_slope_holds', 0):,.0f}"
            )
        vel = trends.get("velocity") or {}
        if vel.get("services_by_acceleration"):
            lines.append("")
            lines.append("### Cost acceleration (services)")
            lines.append("")
            for s in vel["services_by_acceleration"][:10]:
                lines.append(
                    f"- {s['service']}: latest=${s['latest']:,.2f} "
                    f"Δ={s['delta']:,.2f} accel={s['acceleration']:,.2f}"
                )
        bv = trends.get("baseline_vs_variable") or {}
        if bv:
            lines.append("")
            lines.append("### Baseline vs variable")
            lines.append(
                f"- Fixed-ish latest ${bv.get('fixed_latest', 0):,.2f} "
                f"(slope/snapshot {bv.get('fixed_slope_per_snapshot', 0):,.2f})"
            )
            lines.append(
                f"- Variable latest ${bv.get('variable_latest', 0):,.2f} "
                f"(slope/snapshot {bv.get('variable_slope_per_snapshot', 0):,.2f})"
            )
        bands = trends.get("bands") or {}
        if bands:
            lines.append("")
            lines.append("### Statistical bands (avg daily 7d across snapshots)")
            lines.append(
                f"- P10 ${bands.get('p10', 0):,.2f} · P50 ${bands.get('p50', 0):,.2f} · "
                f"P90 ${bands.get('p90', 0):,.2f} · σ ${bands.get('stdev', 0):,.2f}"
            )
        breach = trends.get("budget_breach_horizon") or {}
        if breach:
            lines.append("")
            lines.append("### Budget breach horizon")
            lines.append("```json")
            lines.append(json.dumps(breach, indent=2))
            lines.append("```")
        drift = trends.get("category_drift") or []
        if drift:
            lines.append("")
            lines.append("### Category drift (share pp change first→last snapshot)")
            for d in drift[:10]:
                lines.append(
                    f"- {d['service']}: {d['share_first']*100:.1f}% → {d['share_last']*100:.1f}% "
                    f"({d['delta_pp']:+.1f} pp)"
                )
        lines.append("")

    lines.append("---")
    lines.append("_Generated by stokd `aws-cost-analysis` skill toolkit. Read-only._")
    lines.append("")
    return "\n".join(lines)


def cmd_run(args: argparse.Namespace) -> int:
    cfg = load_config()
    lookback = args.lookback_days or cfg.get("default_lookback_days") or 30
    min_n = cfg.get("forecast_min_snapshots") or 4

    profiles: list[str] = []
    if args.all_enabled:
        profiles = [
            n
            for n, p in cfg.get("profiles", {}).items()
            if p.get("enabled", True)
        ]
        if not profiles:
            profiles = list_profiles()
    elif args.profile:
        profiles = [args.profile]
    else:
        # default: enabled config else all
        profiles = [
            n for n, p in cfg.get("profiles", {}).items() if p.get("enabled", True)
        ] or list_profiles()

    if not profiles:
        print("No profiles to analyze", file=sys.stderr)
        return 2

    rc = 0
    for profile in profiles:
        pcfg = (cfg.get("profiles") or {}).get(profile) or {}
        region = args.region or pcfg.get("region")
        print(f"=== run profile={profile} ===", flush=True)
        try:
            snap = build_snapshot(profile, int(lookback), region)
        except Exception as e:
            rc = 1
            print(f"FAILED {profile}: {e}", file=sys.stderr)
            traceback.print_exc()
            continue

        snap_dir = SNAPSHOTS / _safe(profile)
        snap_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        snap_path = snap_dir / f"{ts}.json"
        with snap_path.open("w") as f:
            json.dump(snap, f, indent=2)
            f.write("\n")

        trends = compute_trends(
            profile,
            int(min_n),
            pcfg.get("budget_monthly") or args.budget_monthly,
            pcfg.get("budget_quarterly") or args.budget_quarterly,
        )
        report = render_report(snap, trends, pcfg)
        rep_dir = REPORTS / _safe(profile)
        rep_dir.mkdir(parents=True, exist_ok=True)
        rep_path = rep_dir / f"{ts}.md"
        rep_path.write_text(report)

        # also latest.md
        (rep_dir / "latest.md").write_text(report)
        (snap_dir / "latest.json").write_text(json.dumps(snap, indent=2) + "\n")

        print(f"snapshot={snap_path}")
        print(f"report={rep_path}")
        print(f"account={((snap.get('identity') or {}).get('account'))}")
        print(
            f"avg_daily_7d=${(snap.get('summary') or {}).get('avg_daily_7d', 0):.2f} "
            f"monthly_pace=${(snap.get('summary') or {}).get('monthly_pace_from_7d', 0):.2f}"
        )
        print(f"findings={len((snap.get('inventory') or {}).get('findings') or [])}")
        print(
            f"trends_ready={trends.get('complete_suite')} "
            f"snapshots={trends.get('snapshot_count')}/{min_n}"
        )
        if args.scheduled:
            LOGS.mkdir(parents=True, exist_ok=True)
            with (LOGS / f"{_safe(profile)}.log").open("a") as lf:
                lf.write(f"{ts} ok snapshot={snap_path} report={rep_path}\n")
    return rc


def cmd_trends(args: argparse.Namespace) -> int:
    cfg = load_config()
    profile = args.profile
    if not profile:
        print("--profile required", file=sys.stderr)
        return 2
    pcfg = (cfg.get("profiles") or {}).get(profile) or {}
    min_n = args.min_snapshots or cfg.get("forecast_min_snapshots") or 4
    trends = compute_trends(
        profile,
        int(min_n),
        pcfg.get("budget_monthly"),
        pcfg.get("budget_quarterly"),
    )
    print(json.dumps(trends, indent=2))
    return 0


def schedule_plist_path(profile: str) -> Path:
    return LAUNCH_AGENTS / f"cloud.stokd.cost-analysis.{_safe(profile)}.plist"


def schedule_install(profile: str, cadence: str) -> None:
    LAUNCH_AGENTS.mkdir(parents=True, exist_ok=True)
    log = LOGS / f"{_safe(profile)}.log"
    LOGS.mkdir(parents=True, exist_ok=True)
    py = sys.executable
    # daily 6:30 local; weekly Monday 6:30
    if cadence == "daily":
        cal = """    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key><integer>6</integer>
      <key>Minute</key><integer>30</integer>
    </dict>"""
    else:
        cal = """    <key>StartCalendarInterval</key>
    <dict>
      <key>Weekday</key><integer>1</integer>
      <key>Hour</key><integer>6</integer>
      <key>Minute</key><integer>30</integer>
    </dict>"""
    label = f"cloud.stokd.cost-analysis.{_safe(profile)}"
    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>{py}</string>
      <string>{SCRIPT_PATH}</string>
      <string>run</string>
      <string>--profile</string>
      <string>{profile}</string>
      <string>--scheduled</string>
    </array>
{cal}
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
"""
    path = schedule_plist_path(profile)
    path.write_text(plist)
    # load
    subprocess.run(["launchctl", "unload", str(path)], capture_output=True)
    subprocess.run(["launchctl", "load", str(path)], capture_output=True)
    print(f"installed {path} cadence={cadence}")


def schedule_remove(profile: str) -> None:
    path = schedule_plist_path(profile)
    if path.is_file():
        subprocess.run(["launchctl", "unload", str(path)], capture_output=True)
        path.unlink(missing_ok=True)
        print(f"removed {path}")
    else:
        print(f"no schedule for {profile}")


def cmd_schedule_install(args: argparse.Namespace) -> int:
    cfg = load_config()
    profile = args.profile
    pcfg = (cfg.get("profiles") or {}).get(profile) or {}
    cadence = args.cadence or pcfg.get("schedule") or "weekly"
    if cadence not in ("daily", "weekly"):
        print("cadence must be daily or weekly", file=sys.stderr)
        return 2
    if sys.platform != "darwin":
        print(
            f"# Linux cron example (edit):\n"
            f"30 6 * * {'1' if cadence == 'weekly' else '*'} "
            f"{sys.executable} {SCRIPT_PATH} run --profile {profile} --scheduled"
        )
        return 0
    schedule_install(profile, cadence)
    # persist
    pcfg = cfg["profiles"].setdefault(profile, {})
    pcfg["enabled"] = True
    pcfg["schedule"] = cadence
    save_config(cfg)
    return 0


def cmd_schedule_remove(args: argparse.Namespace) -> int:
    schedule_remove(args.profile)
    cfg = load_config()
    if args.profile in cfg.get("profiles", {}):
        cfg["profiles"][args.profile]["schedule"] = "none"
        save_config(cfg)
    return 0


def cmd_schedule_list(_: argparse.Namespace) -> int:
    if not LAUNCH_AGENTS.is_dir():
        print("no LaunchAgents dir")
        return 0
    for p in sorted(LAUNCH_AGENTS.glob("cloud.stokd.cost-analysis.*.plist")):
        print(p)
    cfg = load_config()
    for name, pcfg in cfg.get("profiles", {}).items():
        print(f"config {name}: schedule={pcfg.get('schedule')} enabled={pcfg.get('enabled')}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Stokd AWS multi-profile cost analysis")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list-profiles", help="List AWS profiles + STS identity")
    sub.add_parser("status", help="Show config and snapshot counts")

    c = sub.add_parser("configure", help="Write/merge config")
    c.add_argument("--from-file")
    c.add_argument("--set-json")
    c.add_argument("--profile")
    c.add_argument("--enable", type=lambda x: x.lower() in ("1", "true", "yes"))
    c.add_argument("--schedule", choices=["none", "daily", "weekly"])
    c.add_argument("--budget-monthly", type=float)
    c.add_argument("--budget-quarterly", type=float)
    c.add_argument("--label")
    c.add_argument("--region")
    c.add_argument("--forecast-min-snapshots", type=int)
    c.add_argument("--apply-schedules", action="store_true")

    r = sub.add_parser("run", help="Collect snapshot + write report")
    r.add_argument("--profile")
    r.add_argument("--all-enabled", action="store_true")
    r.add_argument("--lookback-days", type=int)
    r.add_argument("--region")
    r.add_argument("--budget-monthly", type=float)
    r.add_argument("--budget-quarterly", type=float)
    r.add_argument("--scheduled", action="store_true")

    t = sub.add_parser("trends", help="Looking-forward artifacts from snapshots")
    t.add_argument("--profile", required=True)
    t.add_argument("--min-snapshots", type=int)

    si = sub.add_parser("schedule-install")
    si.add_argument("--profile", required=True)
    si.add_argument("--cadence", choices=["daily", "weekly"])

    sr = sub.add_parser("schedule-remove")
    sr.add_argument("--profile", required=True)

    sub.add_parser("schedule-list")
    return p


def main(argv: list[str] | None = None) -> int:
    ensure_dirs()
    parser = build_parser()
    args = parser.parse_args(argv)
    handlers = {
        "list-profiles": cmd_list_profiles,
        "status": cmd_status,
        "configure": cmd_configure,
        "run": cmd_run,
        "trends": cmd_trends,
        "schedule-install": cmd_schedule_install,
        "schedule-remove": cmd_schedule_remove,
        "schedule-list": cmd_schedule_list,
    }
    return handlers[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
