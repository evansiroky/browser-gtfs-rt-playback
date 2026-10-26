#!/usr/bin/env python3
"""Invariants of .github/workflows (plans/ci-cd.md, specs/deployment.md "Identities").

Parses the workflows and the files that define the identity contract (scripts/lib.sh, infra/*.tf) and
fails when a workflow could reach an identity it should not, or disagrees with the contract.

    scripts/test/workflow-invariants.py              check the workflows in this repository
    scripts/test/workflow-invariants.py --self-test  break each invariant once and require a failure

What this is, and is not. It is a regression net for the repository's own workflows: it catches an
edit that, by mistake or in review, would widen what a workflow can do. It is NOT the security
boundary. A pull request can edit this script and the CI job that runs it. The boundary is the
Workload Identity bindings (each identity is impersonable by one workflow file on one ref; see
scripts/README.md and infra/iam.tf) plus branch protection on main. It also does not parse shell: it
pins the exact shape of the commands that matter and bans the rest of their vocabulary.

Needs PyYAML. Run it with `python -I` so nothing is imported from the working directory.
"""

import itertools
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".github" / "workflows"
EXPR = re.compile(r"\$\{\{(.*?)\}\}", re.S)

# The only actions that may run in a job that can mint a cloud token (`id-token: write`): any step
# there can request the OIDC token. First-party Google/HashiCorp/GitHub actions, pinned by SHA.
TOKEN_JOB_ACTIONS = {
    "actions/checkout",
    "actions/upload-artifact",
    "google-github-actions/auth",
    "google-github-actions/setup-gcloud",
    "hashicorp/setup-terraform",
}
# gcloud sub-commands a token job may run (first words after `gcloud`).
GCLOUD_ALLOWED = [
    ("run", "services", "describe"),
    ("run", "deploy"),
    ("artifacts", "docker", "images", "describe"),
    ("auth", "configure-docker"),
]
DEPLOY_COMMAND = re.compile(
    r'gcloud run deploy "\$SERVICE" --image "\$IMAGE" --region "\$REGION" --project "\$PROJECT" --quiet'
)
PLAN_COMMAND = re.compile(
    r'terraform -chdir=infra plan -input=false -no-color -lock=false -detailed-exitcode > "\$PLAN_FILE" 2>&1 \|\| code=\$\?'
)
# Anything that would touch service settings, secrets, scaling or IAM, or mint other credentials.
FORBIDDEN_TEXT = [
    "--allow-unauthenticated",
    "--no-allow-unauthenticated",
    "--set-env-vars",
    "--update-env-vars",
    "--remove-env-vars",
    "--set-secrets",
    "--update-secrets",
    "--max-instances",
    "--min-instances",
    "--update-labels",
    "--ingress",
    "--service-account",
    "--no-traffic",
    "--cpu",
    "--memory",
    "--concurrency",
    "gcloud run services update",
    "gcloud run services replace",
    "gcloud beta",
    "add-iam-policy-binding",
    "set-iam-policy",
    "gcloud secrets",
    "service-accounts keys",
    "--impersonate-service-account",
    "print-access-token",
    "print-identity-token",
]
MIN_TERRAFORM = (1, 11)
ORG_REPO = "owner/repo"


# ---- Expressions in `if:` ---------------------------------------------------------------------------


def evaluate(source, ctx):
    """Evaluate a GitHub Actions `if` expression (the subset the workflows use) against ctx."""
    source = source.strip()
    match = re.fullmatch(r"\$\{\{(.*)\}\}", source, re.S)
    if match:
        source = match.group(1)
    tokens = re.findall(r"'[^']*'|&&|\|\||==|!=|[()!]|[A-Za-z_][\w.-]*(?:\(\))?|\d+", source)
    pos = [0]

    def peek():
        return tokens[pos[0]] if pos[0] < len(tokens) else None

    def take():
        pos[0] += 1
        return tokens[pos[0] - 1]

    def truthy(value):
        return value not in ("", None, False, 0, "0", "false") if not isinstance(value, bool) else value

    def text(value):
        return ("true" if value else "false") if isinstance(value, bool) else str(value).lower()

    def primary():
        token = take()
        if token == "(":
            value = parse_or()
            take()  # )
            return value
        if token.startswith("'"):
            return token[1:-1]
        if token.endswith("()"):
            return {"cancelled()": False, "always()": True, "success()": True, "failure()": False}[token]
        if token in ("true", "false"):
            return token == "true"
        return ctx.get(token, "")

    def unary():
        if peek() == "!":
            take()
            return not truthy(unary())
        return primary()

    def equality():
        left = unary()
        while peek() in ("==", "!="):
            operator = take()
            right = unary()
            same = text(left) == text(right)
            left = same if operator == "==" else not same
        return left

    def parse_and():
        left = equality()
        while peek() == "&&":
            take()
            right = equality()
            left = right if truthy(left) else left
        return left

    def parse_or():
        left = parse_and()
        while peek() == "||":
            take()
            right = parse_and()
            left = left if truthy(left) else right
        return left

    value = parse_or()
    if pos[0] != len(tokens):
        raise ValueError(f"cannot parse if expression: {source!r}")
    return truthy(value)


def job_runs(job, ctx):
    condition = job.get("if")
    return True if condition is None else evaluate(str(condition), ctx)


# ---- Helpers ----------------------------------------------------------------------------------------


def walk(node):
    """Yield every key and every string in a parsed YAML document."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield key
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)
    elif isinstance(node, str):
        yield node


def triggers(doc):
    # PyYAML (YAML 1.1) reads the key `on` as the boolean True.
    on = doc.get("on", doc.get(True))
    if isinstance(on, str):
        return {on: None}
    if isinstance(on, list):
        return {name: None for name in on}
    return on if isinstance(on, dict) else {}


def read_contract():
    lib = (ROOT / "scripts" / "lib.sh").read_text()
    const = dict(re.findall(r'^readonly (\w+)="(.*)"$', lib, re.M))
    iam = (ROOT / "infra" / "iam.tf").read_text()
    locals_tf = (ROOT / "infra" / "locals.tf").read_text()
    deploy_sa = re.search(
        r'resource "google_service_account" "deploy" \{\s*account_id\s*=\s*"([^"]+)"', iam
    ).group(1)
    member = re.search(
        r'"principalSet://iam\.googleapis\.com/\$\{var\.wif_pool\}/attribute\.target/'
        r'\$\{var\.github_repository\}/(\.github/workflows/[\w.-]+):([^"]+)"',
        iam,
    )
    return {
        "vars": {const[k] for k in const if k.startswith("GH_VAR_")},
        "var_project_id": const["GH_VAR_PROJECT_ID"],
        "var_project_number": const["GH_VAR_PROJECT_NUMBER"],
        "var_region": const["GH_VAR_REGION"],
        "var_state_bucket": const["GH_VAR_STATE_BUCKET"],
        "pool": const["WIF_POOL_ID"],
        "location": const["WIF_LOCATION"],
        "provider": const["WIF_PROVIDER_ID"],
        "plan_sa": const["PLAN_SA_ID"],
        "apply_sa": const["APPLY_SA_ID"],
        "deploy_sa": deploy_sa,
        "infra_file": Path(const["INFRA_WORKFLOW_PATH"]).name,
        "plan_target": const["PLAN_TARGET"],
        "apply_target": const["APPLY_TARGET"],
        "deploy_file": Path(member.group(1)).name,
        "deploy_target": member.group(2),
        "service": re.search(r'service_name\s*=\s*"([^"]+)"', locals_tf).group(1),
        "repository": re.search(r'repository_id\s*=\s*"([^"]+)"', locals_tf).group(1),
    }


def gcloud_commands(run):
    """The first words of every gcloud invocation in a script, ignoring echoed messages and comments."""
    lines = [
        line
        for line in run.replace("\\\n", " ").splitlines()
        if not line.lstrip().startswith(("echo", "#"))
    ]
    return [
        tuple(words.split())
        for words in re.findall(r"\bgcloud((?:\s+[a-z][a-z-]*){0,4})", "\n".join(lines))
    ]


# ---- The check --------------------------------------------------------------------------------------


def check(workflows, dependabot, contract, github_files=()):
    """Return a list of violations for {file name: yaml text}."""
    bad = []
    docs = {}
    for name, text in workflows.items():
        try:
            docs[name] = yaml.safe_load(text)
        except yaml.YAMLError as error:
            return [f"{name}: not valid YAML: {error}"]
        if not isinstance(docs[name], dict) or not isinstance(docs[name].get("jobs"), dict):
            return [f"{name}: not a workflow (no jobs)"]
    for path in github_files:
        if path.startswith(".github/actions/") or path.endswith(("/action.yml", "/action.yaml")):
            bad.append(f"{path}: composite or local actions are not allowed (they would escape this check)")

    c = contract
    pn = f"${{{{ vars.{c['var_project_number']} }}}}"
    pid = f"${{{{ vars.{c['var_project_id']} }}}}"
    region = f"${{{{ vars.{c['var_region']} }}}}"
    pool = f"projects/{pn}/locations/{c['location']}/workloadIdentityPools/{c['pool']}"
    provider = f"{pool}/providers/{c['provider']}"

    def sa(account):
        return f"{account}@{pid}.iam.gserviceaccount.com"

    # (file, job) -> the service account that job authenticates as. Nothing else may authenticate.
    allowed = {
        (c["deploy_file"], "deploy"): sa(c["deploy_sa"]),
        (c["infra_file"], "plan"): sa(c["plan_sa"]),
        (c["infra_file"], "apply"): sa(c["apply_sa"]),
    }
    cloud_perms = {"contents": "read", "id-token": "write"}
    commenter = (c["infra_file"], "comment")

    # The workflows hardcode these targets (event and ref conditions); a changed contract must be noticed.
    if (c["plan_target"], c["apply_target"], c["deploy_target"]) != (
        "pr",
        "refs/heads/main",
        "refs/heads/main",
    ):
        bad.append("identity targets in scripts/lib.sh or infra/iam.tf changed; update the workflows")

    for key in allowed:
        if key[0] not in docs or key[1] not in docs[key[0]]["jobs"]:
            bad.append(f"{key[0]}: job '{key[1]}' is missing")
    for needed in ("ci.yml", c["deploy_file"], c["infra_file"]):
        if needed not in docs:
            bad.append(f"{needed}: missing")
    if bad:
        return bad

    all_vars = set()
    terraform_versions = set()

    for fname, doc in docs.items():
        on = triggers(doc)
        if "pull_request_target" in on:
            bad.append(f"{fname}: uses pull_request_target")
        if doc.get("permissions") != {"contents": "read"}:
            bad.append(f"{fname}: workflow-level permissions must be exactly contents: read")

        for item in walk(doc):
            if item == "secrets":
                bad.append(f"{fname}: uses a secrets key (repository variables only)")
            if item == "credentials_json":
                bad.append(f"{fname}: authenticates with a key (credentials_json)")
            if not isinstance(item, str):
                continue
            for expr in EXPR.findall(item):
                if re.search(r"\bsecrets\b", expr):
                    bad.append(f"{fname}: uses the secrets context: {expr.strip()}")
                all_vars.update(re.findall(r"\bvars\.(\w+)", expr))
            for needle in FORBIDDEN_TEXT:
                if needle in item:
                    bad.append(f"{fname}: forbidden command text {needle!r}")
            if "gcloud run deploy" in item and fname != c["deploy_file"]:
                bad.append(f"{fname}: deploys outside {c['deploy_file']}")

        for jname, job in doc["jobs"].items():
            where = f"{fname}:{jname}"
            token_job = (fname, jname) in allowed
            perms = job.get("permissions")
            if perms == "write-all" or (isinstance(perms, str) and "write" in perms):
                bad.append(f"{where}: permissions string {perms!r}")
            perms = perms if isinstance(perms, dict) else {}
            if perms.get("id-token") == "write" and not token_job:
                bad.append(f"{where}: requests id-token: write")
            if token_job and perms != cloud_perms:
                bad.append(f"{where}: permissions must be exactly {cloud_perms}")
            for scope, level in perms.items():
                if level == "write" and scope != "id-token":
                    if (fname, jname) != commenter or scope != "pull-requests":
                        bad.append(f"{where}: {scope}: write is not allowed here")
            if (fname, jname) == commenter and set(perms) != {"pull-requests"}:
                bad.append(f"{where}: the comment job needs exactly pull-requests: write")

            # A job-level `uses` is a reusable workflow: only the local CI workflow, from deploy.yml.
            if "uses" in job:
                if not (fname == c["deploy_file"] and job["uses"] == "./.github/workflows/ci.yml"):
                    bad.append(f"{where}: calls {job['uses']!r}; only ./.github/workflows/ci.yml from {c['deploy_file']}")
                if token_job:
                    bad.append(f"{where}: an identity job must be defined in this file, not called")
            if token_job and ("container" in job or "services" in job):
                bad.append(f"{where}: an identity job must not run containers or services")

            steps = job.get("steps", [])
            if not isinstance(steps, list):
                bad.append(f"{where}: steps is not a list")
                steps = []
            auth_steps = [
                s for s in steps if str(s.get("uses", "")).startswith("google-github-actions/auth@")
            ]
            if auth_steps and not token_job:
                bad.append(f"{where}: authenticates to Google but is not an allowed identity job")
            if token_job:
                if len(auth_steps) != 1:
                    bad.append(f"{where}: must have exactly one google-github-actions/auth step")
                for step in auth_steps:
                    with_ = step.get("with", {})
                    if with_.get("service_account") != allowed[(fname, jname)]:
                        bad.append(
                            f"{where}: service_account is {with_.get('service_account')!r}, "
                            f"expected {allowed[(fname, jname)]!r}"
                        )
                    if with_.get("workload_identity_provider") != provider:
                        bad.append(
                            f"{where}: workload_identity_provider is "
                            f"{with_.get('workload_identity_provider')!r}, expected {provider!r}"
                        )
                    if set(with_) - {"service_account", "workload_identity_provider"}:
                        bad.append(f"{where}: unexpected auth inputs {sorted(with_)}")
            else:
                text = json.dumps(job)
                if "iam.gserviceaccount.com" in text or "/providers/" in text:
                    bad.append(f"{where}: mentions a service account or WIF provider")

            for index, step in enumerate(steps):
                if not isinstance(step, dict):
                    bad.append(f"{where}: step {index} is not a mapping")
                    continue
                uses = step.get("uses")
                if uses is not None:
                    uses = str(uses)
                    if uses.startswith("docker://"):
                        bad.append(f"{where}: docker:// action {uses!r}")
                    elif uses.startswith("./"):
                        bad.append(f"{where}: local action {uses!r} escapes this check")
                    elif not re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", uses):
                        bad.append(f"{where}: action {uses!r} is not pinned to a full commit SHA")
                    action = uses.split("@")[0]
                    if token_job and "/".join(action.split("/")[:2]) not in TOKEN_JOB_ACTIONS:
                        bad.append(f"{where}: action {action!r} may not run in a job that can mint a token")
                    if action.startswith("actions/checkout") and step.get("with", {}).get("persist-credentials") is not False:
                        bad.append(f"{where}: checkout must set persist-credentials: false")
                    if action.startswith("hashicorp/setup-terraform"):
                        version = str(step.get("with", {}).get("terraform_version", ""))
                        terraform_versions.add(version)
                        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
                            bad.append(f"{where}: terraform_version {version!r} is not an exact pin")
                        elif tuple(int(p) for p in version.split(".")[:2]) < MIN_TERRAFORM:
                            bad.append(f"{where}: terraform_version {version} < 1.11")
                    if action.startswith("actions/github-script"):
                        if "${{" in str(step.get("with", {}).get("script", "")):
                            bad.append(f"{where}: github-script source interpolates an expression")
                    if "${{" in str(step.get("with", {}).get("args", "")):
                        bad.append(f"{where}: action args interpolate an expression")
                for key in ("shell", "working-directory"):
                    if key in step and "${{" in str(step[key]):
                        bad.append(f"{where}: {key} interpolates an expression")
                if "run" in step:
                    run = step["run"]
                    if not isinstance(run, str):
                        bad.append(f"{where}: run is not a string")
                        continue
                    if "${{" in run:
                        bad.append(f"{where}: run block interpolates an expression; pass it through env")
                    if token_job:
                        for words in gcloud_commands(run):
                            if not any(words[: len(ok)] == ok for ok in GCLOUD_ALLOWED):
                                bad.append(f"{where}: gcloud {' '.join(words)} is not an allowed command")

        # ---- per-workflow rules --------------------------------------------------------------
        jobs = doc["jobs"]
        if fname == c["deploy_file"]:
            if set(on) != {"push", "workflow_dispatch"}:
                bad.append(f"{fname}: triggers must be exactly push and workflow_dispatch")
            push = on.get("push") or {}
            if push.get("branches") != ["main"] or "tags" in push:
                bad.append(f"{fname}: push must be limited to branches: [main]")
            sha_input = ((on.get("workflow_dispatch") or {}).get("inputs") or {}).get("sha") or {}
            if sha_input.get("required") is not True:
                bad.append(f"{fname}: workflow_dispatch needs a required sha input")
            deploy = jobs["deploy"]
            if not deploy.get("steps"):
                bad.append(f"{fname}: the deploy job must be defined in this file")
            if deploy.get("needs") not in ("ci", ["ci"]):
                bad.append(f"{fname}: deploy must need ci")
            if (jobs.get("ci", {}).get("with") or {}).get("deploy_gate") is not True:
                bad.append(f"{fname}: the ci call must pass deploy_gate: true")
            first = (deploy.get("steps") or [{}])[0]
            if (
                "github.ref != 'refs/heads/main'" not in str(first.get("if"))
                or "exit 1" not in str(first.get("run", ""))
            ):
                bad.append(f"{fname}: the first deploy step must fail when not on main")
            if deploy.get("concurrency") != {"group": "deploy", "cancel-in-progress": False}:
                bad.append(f"{fname}: deploy must be serialized and never cancelled")
            env = deploy.get("env", {})
            if env.get("SERVICE") != c["service"] or env.get("REPOSITORY") != c["repository"]:
                bad.append(f"{fname}: SERVICE/REPOSITORY differ from infra/locals.tf")
            if env.get("PROJECT") != pid or env.get("REGION") != region:
                bad.append(f"{fname}: PROJECT/REGION must come from the contract variables")
            deploy_lines = [
                line.strip()
                for step in deploy.get("steps", [])
                if isinstance(step.get("run"), str)
                for line in step["run"].replace("\\\n", " ").splitlines()
                if "gcloud run deploy" in line
            ]
            if len(deploy_lines) != 1 or not DEPLOY_COMMAND.fullmatch(deploy_lines[0]):
                bad.append(f"{fname}: the only deploy command must be exactly the image-only gcloud run deploy, got {deploy_lines}")
            for step in deploy.get("steps", []):
                run = step.get("run") if isinstance(step.get("run"), str) else ""
                if re.search(r"docker (buildx|run|compose)|setup-buildx|build-push", run) and "imagetools inspect" not in run and "container-smoke" not in run:
                    bad.append(f"{fname}: unexpected docker use in the deploy job")
        elif fname == c["infra_file"]:
            if set(on) != {"pull_request", "push"}:
                bad.append(f"{fname}: triggers must be exactly pull_request and push")
            if (on.get("push") or {}).get("branches") != ["main"] or "tags" in (on.get("push") or {}):
                bad.append(f"{fname}: push must be limited to branches: [main]")
            plan, apply_ = jobs["plan"], jobs["apply"]
            if apply_.get("concurrency") != {"group": "infra-apply", "cancel-in-progress": False}:
                bad.append(f"{fname}:apply: must be serialized and never cancelled")
            if "needs" in apply_:
                bad.append(f"{fname}:apply: must not depend on another job (the stale check lives inside it)")
            plan_runs = "\n".join(s["run"] for s in plan["steps"] if isinstance(s.get("run"), str))
            if re.search(r"\b(apply|destroy|import|force-unlock|state|gcloud|impersonate)\b", plan_runs):
                bad.append(f"{fname}:plan: the pull-request path must only plan")
            plan_lines = [l.strip() for l in plan_runs.splitlines() if "plan " in l and "terraform" in l and not l.lstrip().startswith(("echo", "#"))]
            if len(plan_lines) != 1 or not PLAN_COMMAND.fullmatch(plan_lines[0]):
                bad.append(f"{fname}:plan: pull-request plans must be the read-only, -lock=false plan, got {plan_lines}")
            plan_step = [s for s in plan["steps"] if s.get("id") == "plan"]
            last = plan_step[0]["run"].strip().splitlines()[-1].strip() if plan_step and isinstance(plan_step[0].get("run"), str) else ""
            if last != "[[ $code -ne 1 ]]":
                bad.append(f"{fname}:plan: a plan error (exit code 1) must fail the job")
            # The apply job: stale check first, everything after it guarded, optimistic image checks.
            steps = apply_["steps"]
            ids = [s.get("id") for s in steps]
            if "fresh" not in ids:
                bad.append(f"{fname}:apply: missing the 'fresh' stale check")
            else:
                position = ids.index("fresh")
                if "git diff --quiet" not in str(steps[position].get("run")) or "origin/main" not in str(steps[position].get("run")):
                    bad.append(f"{fname}:apply: the stale check must compare against origin/main")
                for step in steps[position + 1 :]:
                    if "steps.fresh.outputs.stale == 'false'" not in str(step.get("if")):
                        bad.append(f"{fname}:apply: step after the stale check is not guarded: {step.get('name') or step.get('uses') or step.get('run')}")
            apply_runs = "\n".join(s["run"] for s in steps if isinstance(s.get("run"), str))
            for needle in (
                "-out=tfplan",
                "apply -input=false -no-color tfplan",
                "metadata.generation",
                "read_service",
                ">= 2",
            ):
                if needle not in apply_runs:
                    bad.append(f"{fname}:apply: image checks around the apply are missing ({needle!r})")
            for jname in ("plan", "apply"):
                env = jobs[jname].get("env", {})
                expected_env = {
                    "TF_STATE_BUCKET": f"${{{{ vars.{c['var_state_bucket']} }}}}",
                    "TF_VAR_project_id": pid,
                    "TF_VAR_region": region,
                    "TF_VAR_github_repository": "${{ github.repository }}",
                    "TF_VAR_wif_pool": pool,
                }
                if jname == "apply":
                    expected_env["SERVICE"] = c["service"]
                if env != expected_env:
                    bad.append(f"{fname}:{jname}: env {env} differs from {expected_env}")
                runs = "\n".join(s["run"] for s in jobs[jname]["steps"] if isinstance(s.get("run"), str))
                if 'terraform -chdir=infra init -input=false -backend-config="bucket=$TF_STATE_BUCKET"' not in runs:
                    bad.append(f"{fname}:{jname}: init must pass the state bucket from TF_STATE_BUCKET")
                if "billing_account" in runs or "billing_account" in env:
                    bad.append(f"{fname}:{jname}: billing_account is derived and must not be passed")
        elif fname == "ci.yml":
            if set(on) != {"pull_request", "push", "workflow_call", "workflow_dispatch"}:
                bad.append(f"{fname}: unexpected triggers {sorted(on)}")
            audit_text = {j: json.dumps(v) for j, v in jobs.items()}
            if [j for j, t in audit_text.items() if "npm audit" in t] != ["audit"]:
                bad.append(f"{fname}: npm audit must live only in the audit job")
            audit_steps = [s for s in jobs.get("audit", {}).get("steps", []) if "npm audit" in str(s.get("run"))]
            if not audit_steps or audit_steps[0].get("continue-on-error") is not True:
                bad.append(f"{fname}:audit: the audit step must be continue-on-error (it informs, it never blocks)")

        bad.extend(truth_tables(fname, doc, on, c))

    if all_vars - c["vars"]:
        bad.append(f"workflows read variables outside the contract: {sorted(all_vars - c['vars'])}")
    if len(terraform_versions) > 1:
        bad.append(f"inconsistent terraform_version pins: {sorted(terraform_versions)}")

    try:
        updates = {u["package-ecosystem"]: u for u in yaml.safe_load(dependabot)["updates"]}
    except (yaml.YAMLError, KeyError, TypeError):
        updates = {}
    for ecosystem in ("github-actions", "docker", "npm", "terraform"):
        if updates.get(ecosystem, {}).get("schedule", {}).get("interval") != "weekly":
            bad.append(f"dependabot.yml: {ecosystem} must be updated weekly")
    return bad


def truth_tables(fname, doc, on, c):
    """Evaluate the job conditions that gate the identities over every relevant context."""
    bad = []
    jobs = doc["jobs"]

    def ctx_for(event, ref, **extra):
        ctx = {
            "github.event_name": event,
            "github.ref": ref,
            "github.repository": ORG_REPO,
            "github.actor": "alice",
        }
        ctx.update(extra)
        return ctx

    def refs(event):
        return {
            "pull_request": ["refs/pull/1/merge"],
            "push": ["refs/heads/main", "refs/heads/feature"],
            "workflow_dispatch": ["refs/heads/main", "refs/heads/feature"],
        }[event]

    if fname == c["infra_file"]:
        for event, head, actor in itertools.product(
            ("pull_request", "push"), (ORG_REPO, "fork/repo"), ("alice", "dependabot[bot]")
        ):
            for ref in refs(event):
                extra = {"github.actor": actor}
                if event == "pull_request":
                    extra["github.event.pull_request.head.repo.full_name"] = head
                ctx = ctx_for(event, ref, **extra)
                label = f"{event} {ref} head={head} actor={actor}"
                want_apply = event == "push" and ref == "refs/heads/main"
                want_plan = event == "pull_request" and head == ORG_REPO and actor != "dependabot[bot]"
                want_skip = event == "pull_request" and not want_plan
                for jname, want in (("apply", want_apply), ("plan", want_plan), ("skip-plan", want_skip)):
                    if jname in jobs and job_runs(jobs[jname], ctx) != want:
                        bad.append(f"{fname}:{jname}: runs={not want} for {label}, expected {want}")
        for result, cancelled in itertools.product(("success", "failure", "skipped", "cancelled"), (False, True)):
            ctx = {"needs.plan.result": result, "github.event_name": "pull_request"}
            if cancelled:
                ctx = {"needs.plan.result": result}
            job = dict(jobs["comment"])
            condition = str(job.get("if"))
            if cancelled:
                condition = condition.replace("!cancelled()", "false")
            want = (not cancelled) and result != "skipped"
            if evaluate(condition, ctx) != want:
                bad.append(f"{fname}:comment: runs={not want} for plan result {result}, cancelled={cancelled}")
    elif fname == c["deploy_file"]:
        for event in ("push", "workflow_dispatch"):
            for ref in refs(event):
                for ci_result, cancelled in itertools.product(("success", "failure", "skipped", "cancelled"), (False, True)):
                    ctx = ctx_for(event, ref, **{"needs.ci.result": ci_result})
                    condition = str(jobs["deploy"].get("if")).replace("!cancelled()", "false" if cancelled else "true")
                    want = (not cancelled) and (event == "workflow_dispatch" or ci_result == "success")
                    if evaluate(condition, ctx) != want:
                        bad.append(f"{fname}:deploy: runs={not want} for {event} ci={ci_result} cancelled={cancelled}")
                if job_runs(jobs["ci"], ctx_for(event, ref)) != (event == "push"):
                    bad.append(f"{fname}:ci: must run for push only (rollbacks skip CI)")
    elif fname == "ci.yml":
        for event in ("pull_request", "push", "workflow_dispatch"):
            for gate in ("", "true"):
                ctx = ctx_for(event, "refs/heads/main", **{"inputs.deploy_gate": gate})
                for jname, job in jobs.items():
                    optional = jname in ("audit", "image")
                    want = not (optional and gate == "true")
                    if job_runs(job, ctx) != want:
                        bad.append(f"ci.yml:{jname}: runs={not want} with deploy_gate={gate!r}")
    return bad


# ---- Self-test: break each invariant once ------------------------------------------------------------


def rep(fname, old, new):
    def mutate(files):
        files = dict(files)
        if old not in files[fname]:
            raise LookupError(f"anchor not found in {fname}: {old[:60]!r}")
        files[fname] = files[fname].replace(old, new, 1)
        return files

    return mutate


def add_file(name, text):
    def mutate(files):
        files = dict(files)
        files[name] = text
        return files

    return mutate


APPLY_IF = "if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    timeout-minutes: 30"
PLAN_IF = "if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'"
SETUP_GCLOUD_DEPLOY = "      - uses: google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db # v3.0.1\n"
EVIL_WORKFLOW = """name: Evil
on: [pull_request]
permissions:
  contents: read
jobs:
  x:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093
        with:
          workload_identity_provider: projects/${{ vars.GCP_PROJECT_NUMBER }}/locations/global/workloadIdentityPools/github/providers/github
          service_account: tf-apply@${{ vars.GCP_PROJECT_ID }}.iam.gserviceaccount.com
"""

MUTATIONS = [
    # (name, expected violation regex, mutation)
    ("pull_request_target trigger", r"pull_request_target", rep("ci.yml", "  pull_request:\n", "  pull_request_target:\n")),
    ("pull_request_target nested beside pull_request", r"pull_request_target", rep("ci.yml", "  pull_request:\n", "  pull_request:\n  pull_request_target:\n")),
    ("write-all permissions", r"permissions", rep("ci.yml", "permissions:\n  contents: read\n\n# Superseded", "permissions: write-all\n\n# Superseded")),
    ("id-token at workflow level", r"workflow-level permissions", rep("deploy.yml", "permissions:\n  contents: read\n\njobs:", "permissions:\n  contents: read\n  id-token: write\n\njobs:")),
    ("id-token on a CI job", r"ci.yml:check: requests id-token", rep("ci.yml", "    name: Lint, types, tests, build\n    runs-on: ubuntu-latest\n", "    name: Lint, types, tests, build\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n")),
    ("extra job with actions: write", r"actions: write", rep("infra.yml", "  # Push to main only.", "  extra:\n    runs-on: ubuntu-latest\n    permissions:\n      actions: write\n    steps:\n      - run: echo hi\n  # Push to main only.")),
    ("secrets context", r"secrets context", rep("ci.yml", "      - run: npm ci\n      - run: npm run lint", "      - run: npm ci\n        env:\n          T: ${{ secrets.T }}\n      - run: npm run lint")),
    ("secrets: inherit on the CI call", r"secrets key", rep("deploy.yml", "    uses: ./.github/workflows/ci.yml\n", "    uses: ./.github/workflows/ci.yml\n    secrets: inherit\n")),
    ("variable outside the contract", r"outside the contract", rep("deploy.yml", "PROJECT: ${{ vars.GCP_PROJECT_ID }}", "PROJECT: ${{ vars.GCP_PROJECT }}")),
    ("deploy authenticates as tf-apply", r"deploy:.*service_account", rep("deploy.yml", "service_account: deploy@", "service_account: tf-apply@")),
    ("wrong WIF provider", r"workload_identity_provider", rep("deploy.yml", "workloadIdentityPools/github/providers/github", "workloadIdentityPools/github/providers/gh")),
    ("plan authenticates as tf-apply", r"plan: service_account", rep("infra.yml", "service_account: tf-plan@", "service_account: tf-apply@")),
    ("apply authenticates as tf-plan", r"apply: service_account", rep("infra.yml", "service_account: tf-apply@", "service_account: tf-plan@")),
    ("new .yaml workflow that authenticates", r"evil.yaml:.*(authenticates|requests id-token)", add_file("evil.yaml", EVIL_WORKFLOW)),
    ("deploy on pull_request", r"deploy.yml: triggers", rep("deploy.yml", "on:\n  push:", "on:\n  pull_request:\n  push:")),
    ("deploy from any branch", r"limited to branches", rep("deploy.yml", "    branches: [main]\n", "    branches: [main, dev]\n")),
    ("deploy on tags", r"limited to branches", rep("deploy.yml", "    branches: [main]\n", "    branches: [main]\n    tags: ['*']\n")),
    ("deploy without the main guard", r"fail when not on main", rep("deploy.yml", "if: github.ref != 'refs/heads/main'", "if: github.ref != 'refs/heads/dev'")),
    ("deploy job moved to a reusable workflow", r"must be defined in this file|calls", rep("deploy.yml", "  deploy:\n    name: Build and deploy\n", "  deploy:\n    uses: ./.github/workflows/other.yml\n    name: Build and deploy\n")),
    ("deploy not serialized", r"serialized", rep("deploy.yml", "      group: deploy\n      cancel-in-progress: false", "      group: deploy\n      cancel-in-progress: true")),
    ("deploy runs whatever the CI result", r"deploy: runs=True for push ci=failure", rep("deploy.yml", "needs.ci.result == 'success'", "always()")),
    ("rollback waits for CI", r"ci: must run for push only", rep("deploy.yml", "    if: github.event_name == 'push'\n    uses:", "    uses:")),
    ("CI call without deploy_gate", r"deploy_gate", rep("deploy.yml", "deploy_gate: true", "deploy_gate: false")),
    ("audit gates again (continue-on-error removed)", r"continue-on-error", rep("ci.yml", "        continue-on-error: true\n", "")),
    ("npm audit back in the check job", r"npm audit must live only", rep("ci.yml", "      - run: npm run format:check\n", "      - run: npm run format:check\n      - run: npm audit --omit=dev\n")),
    ("image job not skippable", r"image: runs=True with deploy_gate", rep("ci.yml", "    name: Container image (build only)\n    if: ${{ !inputs.deploy_gate }}\n", "    name: Container image (build only)\n")),
    ("audit job runs for the deploy call", r"audit: runs=True with deploy_gate", rep("ci.yml", "    name: Dependency advisories (informational)\n    if: ${{ !inputs.deploy_gate }}\n", "    name: Dependency advisories (informational)\n")),
    ("extra deploy flag", r"only deploy command", rep("deploy.yml", '--project "$PROJECT" --quiet', '--project "$PROJECT" --allow-unauthenticated')),
    ("deploy sets env vars", r"only deploy command|set-env-vars", rep("deploy.yml", '--project "$PROJECT" --quiet', '--project "$PROJECT" --set-env-vars=A=b')),
    ("extra deploy flags smuggled through $EXTRA", r"only deploy command", rep("deploy.yml", '--project "$PROJECT" --quiet', '--project "$PROJECT" --quiet $EXTRA')),
    ("second gcloud step with --cpu", r"forbidden command text|not an allowed command", rep("deploy.yml", "      - name: Summary\n        if:", '      - run: gcloud run services update "$SERVICE" --cpu 8\n      - name: Summary\n        if:')),
    ("expression in a run block", r"run block interpolates", rep("deploy.yml", 'git worktree add --detach "$RUNNER_TEMP/src" "$SHA"', 'git worktree add --detach "$RUNNER_TEMP/src" "${{ github.event.head_commit.message }}"')),
    ("head_ref in a run block", r"run block interpolates", rep("infra.yml", '          cat "$PLAN_FILE"\n', '          echo ${{ github.head_ref }}\n          cat "$PLAN_FILE"\n')),
    ("expression in shell:", r"shell interpolates", rep("ci.yml", "      - run: npm run lint\n", '      - run: npm run lint\n        shell: bash -c "echo ${{ github.head_ref }}; bash {0}"\n')),
    ("expression in working-directory", r"working-directory interpolates", rep("ci.yml", "      - run: npm run lint\n", "      - run: npm run lint\n        working-directory: ${{ github.head_ref }}\n")),
    ("expression in github-script", r"github-script source", rep("infra.yml", "const marker = '<!--", "const t = '${{ github.event.pull_request.title }}'; const marker = '<!--")),
    ("docker:// action with an expression", r"docker://|args interpolate", rep("ci.yml", "      - run: npm run lint\n", '      - uses: docker://alpine:latest\n        with:\n          args: sh -c "echo ${{ github.event.pull_request.title }}"\n')),
    ("run that is not a string", r"run is not a string", rep("ci.yml", "      - run: npm run lint\n", "      - run: 123\n")),
    ("apply reachable from a pull request", r"apply: runs=True for pull_request", rep("infra.yml", APPLY_IF, "if: github.event_name == 'push' && github.ref == 'refs/heads/main' || github.event_name == 'pull_request'\n    runs-on: ubuntu-latest\n    timeout-minutes: 30")),
    ("apply for any ref", r"apply: runs=True for push refs/heads/feature", rep("infra.yml", APPLY_IF, "if: github.event_name == 'push'\n    runs-on: ubuntu-latest\n    timeout-minutes: 30")),
    ("apply with no condition", r"apply: runs=True", rep("infra.yml", APPLY_IF, "runs-on: ubuntu-latest\n    timeout-minutes: 30")),
    ("plan runs on push too", r"plan: runs=True for push", rep("infra.yml", PLAN_IF, "if: github.actor != 'dependabot[bot]'")),
    ("plan without the fork check", r"plan: runs=True for pull_request .*head=fork", rep("infra.yml", " && github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'", " && github.actor != 'dependabot[bot]'")),
    ("plan for Dependabot", r"plan: runs=True .*dependabot", rep("infra.yml", " && github.actor != 'dependabot[bot]'\n    runs-on", "\n    runs-on")),
    ("apply stale check dropped from a step", r"not guarded", rep("infra.yml", "      - if: steps.fresh.outputs.stale == 'false'\n        run: terraform -chdir=infra validate", "      - run: terraform -chdir=infra validate")),
    ("apply stale check no longer compares to main", r"compare against origin/main", rep("infra.yml", 'git diff --quiet "$GITHUB_SHA" origin/main', 'git diff --quiet "$GITHUB_SHA" "$GITHUB_SHA"')),
    ("apply job needs another job", r"must not depend", rep("infra.yml", "  apply:\n    name: Plan and apply\n", "  apply:\n    name: Plan and apply\n    needs: skip-plan\n")),
    ("apply loses the generation check", r"image checks around", rep("infra.yml", ">= 2", ">= 99")),
    ("apply not serialized", r"apply: must be serialized", rep("infra.yml", "      group: infra-apply\n      cancel-in-progress: false", "      group: infra-apply-${{ github.sha }}\n      cancel-in-progress: false")),
    ("plan takes the lock", r"-lock=false", rep("infra.yml", " -lock=false", "")),
    ("-lock=false kept only in an echo", r"-lock=false", rep("infra.yml", "terraform -chdir=infra plan -input=false -no-color -lock=false -detailed-exitcode", "echo -lock=false; terraform -chdir=infra plan -input=false -no-color -detailed-exitcode")),
    ("plan error swallowed", r"plan error", rep("infra.yml", "          [[ $code -ne 1 ]]\n", "          true\n")),
    ("plan job applies", r"only plan", rep("infra.yml", '          cat "$PLAN_FILE"\n', '          terraform -chdir=infra apply -auto-approve\n          cat "$PLAN_FILE"\n')),
    ("plan job applies through a variable", r"only plan", rep("infra.yml", '          cat "$PLAN_FILE"\n', '          tf=terraform; $tf -chdir=infra apply -auto-approve\n          cat "$PLAN_FILE"\n')),
    ("plan job impersonates tf-apply with gcloud", r"only plan|forbidden command text", rep("infra.yml", '          cat "$PLAN_FILE"\n', '          gcloud auth print-access-token --impersonate-service-account="tf-apply@$TF_VAR_project_id.iam.gserviceaccount.com"\n          cat "$PLAN_FILE"\n')),
    ("id-token on the comment job", r"comment", rep("infra.yml", "    permissions:\n      pull-requests: write\n", "    permissions:\n      id-token: write\n      pull-requests: write\n")),
    ("pull-requests write on the plan job", r"plan: permissions must be exactly", rep("infra.yml", "    permissions:\n      contents: read\n      id-token: write\n    concurrency:\n      group: infra-plan", "    permissions:\n      contents: read\n      id-token: write\n      pull-requests: write\n    concurrency:\n      group: infra-plan")),
    ("billing_account passed", r"env .* differs", rep("infra.yml", "      TF_VAR_region: ${{ vars.GCP_REGION }}\n", "      TF_VAR_region: ${{ vars.GCP_REGION }}\n      TF_VAR_billing_account: AAAAAA\n")),
    ("wrong wif_pool", r"env .* differs", rep("infra.yml", "workloadIdentityPools/github\n    steps:", "workloadIdentityPools/gh\n    steps:")),
    ("action pinned to a moving tag", r"not pinned to a full commit SHA", rep("ci.yml", "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1", "actions/checkout@v7")),
    ("action pinned to a branch", r"not pinned to a full commit SHA", rep("ci.yml", "hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e # v4.0.1", "hashicorp/setup-terraform@main")),
    ("unpinned external reusable workflow", r"calls 'someorg", rep("ci.yml", "  scripts:\n", "  ext:\n    uses: someorg/somerepo/.github/workflows/x.yml@main\n    permissions:\n      contents: read\n  scripts:\n")),
    ("third-party action in the deploy job", r"may not run in a job that can mint", rep("deploy.yml", SETUP_GCLOUD_DEPLOY, SETUP_GCLOUD_DEPLOY + "      - uses: random-person/upload-everything@3d3c42e5aac5ba805825da76410c181273ba90b1\n")),
    ("buildx action back in the deploy job", r"may not run in a job that can mint", rep("deploy.yml", SETUP_GCLOUD_DEPLOY, SETUP_GCLOUD_DEPLOY + "      - uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f\n")),
    ("third-party action in the apply job", r"may not run in a job that can mint", rep("infra.yml", "      - if: steps.fresh.outputs.stale == 'false'\n        run: terraform -chdir=infra validate", "      - if: steps.fresh.outputs.stale == 'false'\n        uses: random-person/tf-helper@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - if: steps.fresh.outputs.stale == 'false'\n        run: terraform -chdir=infra validate")),
    ("gcloud used for something else in the apply job", r"not an allowed command", rep("infra.yml", "          attempts=3\n", "          gcloud projects list\n          attempts=3\n")),
    ("persist-credentials removed from a checkout", r"persist-credentials", rep("deploy.yml", "          fetch-depth: 0\n          persist-credentials: false\n", "          fetch-depth: 0\n")),
    ("persist-credentials true on a CI checkout", r"persist-credentials", rep("ci.yml", "        with:\n          persist-credentials: false\n      - uses: actions/setup-node", "        with:\n          persist-credentials: true\n      - uses: actions/setup-node")),
    ("local composite action", r"escapes this check", rep("ci.yml", "      - run: npm run lint\n", "      - uses: ./.github/actions/anything\n")),
    ("Terraform pin below 1.11", r"1\.11|inconsistent", rep("ci.yml", "terraform_version: 1.16.7", "terraform_version: 1.10.5")),
    ("Terraform pins differ", r"inconsistent", rep("infra.yml", "terraform_version: 1.16.7", "terraform_version: 1.16.6")),
]


def self_test(workflows, dependabot, contract):
    baseline = check(workflows, dependabot, contract)
    if baseline:
        print("baseline is not clean:\n  " + "\n  ".join(baseline))
        return 1
    failures = 0
    for name, expect, mutate in MUTATIONS:
        try:
            mutated = mutate(workflows)
        except LookupError as error:
            print(f"BROKEN   {name}: {error}")
            failures += 1
            continue
        found = check(mutated, dependabot, contract)
        if any(re.search(expect, v) for v in found):
            print(f"killed   {name}")
        else:
            print(f"SURVIVED {name}: expected /{expect}/, got {found[:3]}")
            failures += 1
    stripped = re.sub(r"- package-ecosystem: terraform[\s\S]*", "", dependabot)
    found = check(workflows, stripped, contract)
    if any("terraform must be updated weekly" in v for v in found):
        print("killed   dependabot without terraform")
    else:
        print(f"SURVIVED dependabot without terraform: {found}")
        failures += 1
    total = len(MUTATIONS) + 1
    print(f"{total - failures}/{total} invariants enforced")
    return 1 if failures else 0


def main():
    files = sorted(p for pattern in ("*.yml", "*.yaml") for p in WORKFLOW_DIR.glob(pattern))
    workflows = {p.name: p.read_text() for p in files}
    dependabot = (ROOT / ".github" / "dependabot.yml").read_text()
    contract = read_contract()
    if "--self-test" in sys.argv[1:]:
        return self_test(workflows, dependabot, contract)
    github_files = [str(p.relative_to(ROOT)) for p in (ROOT / ".github").rglob("*") if p.is_file()]
    problems = check(workflows, dependabot, contract, github_files)
    for problem in problems:
        print(f"FAIL: {problem}")
    if not problems:
        print(f"ok: {len(workflows)} workflows satisfy the invariants")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
