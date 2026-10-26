#!/usr/bin/env python3
"""Security invariants of .github/workflows (plans/ci-cd.md, specs/deployment.md "Identities").

Parses the workflows and the files that define the identity contract (scripts/lib.sh, infra/*.tf) and
fails if a workflow could reach an identity it should not, or disagrees with the contract.

    scripts/test/workflow-invariants.py              check the workflows in this repository
    scripts/test/workflow-invariants.py --self-test  break each invariant once and require a failure

Needs PyYAML. Run it with `python -I` so nothing is imported from the working directory.
"""

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".github" / "workflows"
EXPR = re.compile(r"\$\{\{(.*?)\}\}", re.S)

# Flags `gcloud run deploy` may carry: the image changes, nothing else (Terraform owns the service).
DEPLOY_FLAGS = {"--image", "--region", "--project", "--quiet"}
# Anything that would touch service settings, secrets, scaling or IAM; forbidden everywhere.
FORBIDDEN_GCLOUD = [
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
    "gcloud run services update",
    "gcloud run services replace",
    "add-iam-policy-binding",
    "set-iam-policy",
    "gcloud secrets",
    "service-accounts keys",
]
MIN_TERRAFORM = (1, 11)


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
    contract = {
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
    return contract


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
    return on or {}


def check(workflows, dependabot, contract):
    """Return a list of violations for {file name: yaml text}."""
    bad = []
    docs = {}
    for name, text in workflows.items():
        try:
            docs[name] = yaml.safe_load(text)
        except yaml.YAMLError as error:
            return [f"{name}: not valid YAML: {error}"]

    c = contract
    pn = f"${{{{ vars.{c['var_project_number']} }}}}"
    pid = f"${{{{ vars.{c['var_project_id']} }}}}"
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
        if key[0] not in docs or key[1] not in docs[key[0]].get("jobs", {}):
            bad.append(f"{key[0]}: job '{key[1]}' is missing")
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

        for jname, job in doc.get("jobs", {}).items():
            where = f"{fname}:{jname}"
            perms = job.get("permissions")
            if perms == "write-all" or (isinstance(perms, str) and "write" in perms):
                bad.append(f"{where}: permissions string {perms!r}")
            perms = perms if isinstance(perms, dict) else {}
            if perms.get("id-token") == "write" and (fname, jname) not in allowed:
                bad.append(f"{where}: requests id-token: write")
            if (fname, jname) in allowed and perms != cloud_perms:
                bad.append(f"{where}: permissions must be exactly {cloud_perms}")
            for scope, level in perms.items():
                if level == "write" and scope != "id-token":
                    if (fname, jname) != commenter or scope != "pull-requests":
                        bad.append(f"{where}: {scope}: write is not allowed here")
            if (fname, jname) == commenter and set(perms) != {"pull-requests"}:
                bad.append(f"{where}: the comment job needs exactly pull-requests: write")

            steps = job.get("steps", [])
            auth_steps = [
                s for s in steps if str(s.get("uses", "")).startswith("google-github-actions/auth@")
            ]
            if auth_steps and (fname, jname) not in allowed:
                bad.append(f"{where}: authenticates to Google but is not an allowed identity job")
            if (fname, jname) in allowed:
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

            for step in steps:
                uses = step.get("uses")
                if uses and not uses.startswith("./"):
                    if not re.fullmatch(
                        r"[\w.-]+/[\w./-]+@(v\d+(\.\d+){0,2}|[0-9a-f]{40})", uses
                    ):
                        bad.append(f"{where}: action {uses!r} is not pinned to a major tag or SHA")
                    if uses.startswith("hashicorp/setup-terraform@"):
                        version = str(step.get("with", {}).get("terraform_version", ""))
                        terraform_versions.add(version)
                        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
                            bad.append(f"{where}: terraform_version {version!r} is not an exact pin")
                        elif tuple(int(p) for p in version.split(".")[:2]) < MIN_TERRAFORM:
                            bad.append(f"{where}: terraform_version {version} < 1.11")
                run = step.get("run")
                if run is not None and "${{" in run:
                    bad.append(f"{where}: run block interpolates an expression; pass it through env")
                if str(uses).startswith("actions/github-script@"):
                    if "${{" in step.get("with", {}).get("script", ""):
                        bad.append(f"{where}: github-script source interpolates an expression")

        # Triggers and the jobs that matter.
        if fname == c["deploy_file"]:
            if set(on) != {"push", "workflow_dispatch"}:
                bad.append(f"{fname}: triggers must be exactly push and workflow_dispatch")
            if (on.get("push") or {}).get("branches") != ["main"]:
                bad.append(f"{fname}: push must be limited to branches: [main]")
            sha_input = ((on.get("workflow_dispatch") or {}).get("inputs") or {}).get("sha") or {}
            if sha_input.get("required") is not True:
                bad.append(f"{fname}: workflow_dispatch needs a required sha input")
            jobs = doc["jobs"]
            if "uses" in jobs["deploy"] or not jobs["deploy"].get("steps"):
                bad.append(f"{fname}: the deploy job must be defined in this file, not called")
            if jobs.get("ci", {}).get("uses") != "./.github/workflows/ci.yml":
                bad.append(f"{fname}: the ci job must call ./.github/workflows/ci.yml")
            if "ci" not in jobs["deploy"].get("needs", []) and jobs["deploy"].get("needs") != "ci":
                bad.append(f"{fname}: deploy must need ci")
            first = jobs["deploy"]["steps"][0]
            if (
                "github.ref != 'refs/heads/main'" not in str(first.get("if"))
                or "exit 1" not in first.get("run", "")
            ):
                bad.append(f"{fname}: the first deploy step must fail when not on main")
            if jobs["deploy"].get("concurrency") != {"group": "deploy", "cancel-in-progress": False}:
                bad.append(f"{fname}: deploy must be serialized and never cancelled")
            env = jobs["deploy"].get("env", {})
            if env.get("SERVICE") != c["service"] or env.get("REPOSITORY") != c["repository"]:
                bad.append(f"{fname}: SERVICE/REPOSITORY differ from infra/locals.tf")
            if env.get("PROJECT") != pid or env.get("REGION") != f"${{{{ vars.{c['var_region']} }}}}":
                bad.append(f"{fname}: PROJECT/REGION must come from the contract variables")
            deploys = [
                s for s in jobs["deploy"]["steps"] if "gcloud run deploy" in s.get("run", "")
            ]
            if len(deploys) != 1:
                bad.append(f"{fname}: expected exactly one gcloud run deploy")
            for step in deploys:
                line = step["run"].replace("\\\n", " ")
                flags = set(re.findall(r"(?<![\w-])--[\w-]+", line))
                if flags - DEPLOY_FLAGS or not {"--image", "--region", "--project"} <= flags:
                    bad.append(f"{fname}: gcloud run deploy flags are {sorted(flags)}")
        elif fname == c["infra_file"]:
            if set(on) != {"pull_request", "push"}:
                bad.append(f"{fname}: triggers must be exactly pull_request and push")
            if (on.get("push") or {}).get("branches") != ["main"]:
                bad.append(f"{fname}: push must be limited to branches: [main]")
            jobs = doc["jobs"]
            plan_if = str(jobs["plan"].get("if"))
            for needle in (
                "github.event_name == 'pull_request'",
                "github.event.pull_request.head.repo.full_name == github.repository",
            ):
                if needle not in plan_if:
                    bad.append(f"{fname}:plan: 'if' must contain {needle}")
            apply_if = str(jobs["apply"].get("if"))
            for needle in ("github.event_name == 'push'", "github.ref == 'refs/heads/main'"):
                if needle not in apply_if:
                    bad.append(f"{fname}:apply: 'if' must contain {needle}")
            if jobs["apply"].get("concurrency") != {"group": "infra-apply", "cancel-in-progress": False}:
                bad.append(f"{fname}:apply: must be serialized and never cancelled")
            plan_runs = " ".join(s.get("run", "") for s in jobs["plan"]["steps"])
            if re.search(r"terraform\b.*\b(apply|destroy|import|force-unlock|state)\b", plan_runs):
                bad.append(f"{fname}:plan: the pull-request path must only plan")
            if "-lock=false" not in plan_runs:
                bad.append(f"{fname}:plan: pull-request plans must run with -lock=false")
            apply_runs = " ".join(s.get("run", "") for s in jobs["apply"]["steps"])
            if "apply" not in apply_runs:
                bad.append(f"{fname}:apply: does not apply")
            for jname in ("plan", "apply"):
                env = jobs[jname].get("env", {})
                expected_env = {
                    "TF_STATE_BUCKET": f"${{{{ vars.{c['var_state_bucket']} }}}}",
                    "TF_VAR_project_id": pid,
                    "TF_VAR_region": f"${{{{ vars.{c['var_region']} }}}}",
                    "TF_VAR_github_repository": "${{ github.repository }}",
                    "TF_VAR_wif_pool": pool,
                }
                if env != expected_env:
                    bad.append(f"{fname}:{jname}: env {env} differs from {expected_env}")
                runs = " ".join(s.get("run", "") for s in jobs[jname]["steps"])
                if 'terraform -chdir=infra init -input=false -backend-config="bucket=$TF_STATE_BUCKET"' not in runs:
                    bad.append(f"{fname}:{jname}: init must pass the state bucket from TF_STATE_BUCKET")
                if "billing_account" in runs or "billing_account" in env:
                    bad.append(f"{fname}:{jname}: billing_account is derived and must not be passed")
        elif fname == "ci.yml":
            if set(on) != {"pull_request", "push", "workflow_call", "workflow_dispatch"}:
                bad.append(f"{fname}: unexpected triggers {sorted(on)}")

        # Whole-file rules on commands.
        for item in walk(doc):
            if isinstance(item, str):
                for needle in FORBIDDEN_GCLOUD:
                    if needle in item:
                        bad.append(f"{fname}: forbidden command text {needle!r}")
                if "gcloud run deploy" in item and fname != c["deploy_file"]:
                    bad.append(f"{fname}: deploys outside {c['deploy_file']}")

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


# Each mutation breaks one invariant. `expect` must match one of the violations it causes, so a
# mutation cannot pass for the wrong reason, and `old` must exist so a renamed line fails loudly.
MUTATIONS = [
    ("pull_request_target trigger", "ci.yml", "  pull_request:\n", "  pull_request_target:\n", r"pull_request_target"),
    ("write-all permissions", "ci.yml", "permissions:\n  contents: read\n\n# Superseded", "permissions: write-all\n\n# Superseded", r"permissions"),
    ("id-token on a CI job", "ci.yml", "    name: Lint, types, tests, build\n    runs-on: ubuntu-latest\n", "    name: Lint, types, tests, build\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n", r"ci.yml:check: requests id-token"),
    ("secrets context", "ci.yml", "      - run: npm ci\n      - run: npm run lint", "      - run: npm ci\n        env:\n          T: ${{ secrets.T }}\n      - run: npm run lint", r"secrets context"),
    ("variable outside the contract", "deploy.yml", "PROJECT: ${{ vars.GCP_PROJECT_ID }}", "PROJECT: ${{ vars.GCP_PROJECT }}", r"outside the contract"),
    ("deploy authenticates as tf-apply", "deploy.yml", "service_account: deploy@", "service_account: tf-apply@", r"deploy:.*service_account"),
    ("wrong WIF provider", "deploy.yml", "workloadIdentityPools/github/providers/github", "workloadIdentityPools/github/providers/gh", r"workload_identity_provider"),
    ("deploy on pull_request", "deploy.yml", "on:\n  push:", "on:\n  pull_request:\n  push:", r"deploy.yml: triggers"),
    ("deploy from any branch", "deploy.yml", "    branches: [main]\n", "    branches: [main, dev]\n", r"limited to branches"),
    ("deploy without the main guard", "deploy.yml", "if: github.ref != 'refs/heads/main'", "if: github.ref != 'refs/heads/dev'", r"fail when not on main"),
    ("deploy job moved to a reusable workflow", "deploy.yml", "  deploy:\n    name: Build and deploy\n", "  deploy:\n    uses: ./.github/workflows/other.yml\n    name: Build and deploy\n", r"must be defined in this file"),
    ("deploy not serialized", "deploy.yml", "      group: deploy\n      cancel-in-progress: false", "      group: deploy\n      cancel-in-progress: true", r"serialized"),
    ("extra deploy flag", "deploy.yml", '--project "$PROJECT" --quiet', '--project "$PROJECT" --allow-unauthenticated', r"allow-unauthenticated|flags"),
    ("deploy sets env vars", "deploy.yml", '--project "$PROJECT" --quiet', '--project "$PROJECT" --set-env-vars=A=b', r"set-env-vars|flags"),
    ("expression in a run block", "deploy.yml", "git worktree add --detach \"$RUNNER_TEMP/src\" \"$SHA\"", "git worktree add --detach \"$RUNNER_TEMP/src\" \"${{ github.event.head_commit.message }}\"", r"run block interpolates"),
    ("head_ref in a run block", "infra.yml", "          cat \"$PLAN_FILE\"\n", "          echo ${{ github.head_ref }}\n          cat \"$PLAN_FILE\"\n", r"run block interpolates"),
    ("expression in github-script", "infra.yml", "const marker = '<!--", "const t = '${{ github.event.pull_request.title }}'; const marker = '<!--", r"github-script source"),
    ("apply reachable from a PR", "infra.yml", "if: github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.fresh", "if: needs.fresh", r"apply: 'if' must contain"),
    ("apply for any ref", "infra.yml", "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.fresh", "github.event_name == 'push' && needs.fresh", r"apply: 'if' must contain"),
    ("plan job also runs on push", "infra.yml", "if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository", "if: github.event.pull_request.head.repo.full_name == github.repository", r"plan: 'if' must contain"),
    ("plan job without the fork check", "infra.yml", " && github.event.pull_request.head.repo.full_name == github.repository\n    runs-on", "\n    runs-on", r"plan: 'if' must contain"),
    ("plan authenticates as tf-apply", "infra.yml", "service_account: tf-plan@", "service_account: tf-apply@", r"plan: service_account"),
    ("apply authenticates as tf-plan", "infra.yml", "service_account: tf-apply@", "service_account: tf-plan@", r"apply: service_account"),
    ("id-token on the comment job", "infra.yml", "    permissions:\n      pull-requests: write\n", "    permissions:\n      id-token: write\n      pull-requests: write\n", r"comment"),
    ("pull-requests write on the plan job", "infra.yml", "    permissions:\n      contents: read\n      id-token: write\n    concurrency:\n      group: infra-plan", "    permissions:\n      contents: read\n      id-token: write\n      pull-requests: write\n    concurrency:\n      group: infra-plan", r"plan: permissions must be exactly"),
    ("plan takes the lock", "infra.yml", " -lock=false", "", r"-lock=false"),
    ("plan job applies", "infra.yml", "          cat \"$PLAN_FILE\"\n", "          terraform -chdir=infra apply -auto-approve\n          cat \"$PLAN_FILE\"\n", r"only plan"),
    ("billing_account passed", "infra.yml", "      TF_VAR_region: ${{ vars.GCP_REGION }}\n", "      TF_VAR_region: ${{ vars.GCP_REGION }}\n      TF_VAR_billing_account: AAAAAA\n", r"env .* differs"),
    ("wrong wif_pool", "infra.yml", "workloadIdentityPools/github\n    steps:", "workloadIdentityPools/gh\n    steps:", r"env .* differs"),
    ("unpinned action", "ci.yml", "uses: docker/setup-buildx-action@v3", "uses: docker/setup-buildx-action@main", r"not pinned"),
    ("terraform pin below 1.11", "ci.yml", "terraform_version: 1.16.7", "terraform_version: 1.10.5", r"1\.11|inconsistent"),
]


def self_test(workflows, dependabot, contract):
    baseline = check(workflows, dependabot, contract)
    if baseline:
        print("baseline is not clean:\n  " + "\n  ".join(baseline))
        return 1
    failures = 0
    for name, fname, old, new, expect in MUTATIONS:
        text = workflows[fname]
        if text.count(old) < 1:
            print(f"BROKEN  {name}: anchor not found in {fname}")
            failures += 1
            continue
        mutated = dict(workflows)
        mutated[fname] = text.replace(old, new, 1)
        found = check(mutated, dependabot, contract)
        if any(re.search(expect, v) for v in found):
            print(f"killed  {name}")
        else:
            print(f"SURVIVED {name}: expected /{expect}/, got {found}")
            failures += 1
    for name, text in (
        ("dependabot without terraform", re.sub(r"- package-ecosystem: terraform[\s\S]*", "", dependabot)),
    ):
        found = check(workflows, text, contract)
        if any("terraform must be updated weekly" in v for v in found):
            print(f"killed  {name}")
        else:
            print(f"SURVIVED {name}: {found}")
            failures += 1
    print(f"{len(MUTATIONS) + 1 - failures}/{len(MUTATIONS) + 1} invariants enforced")
    return 1 if failures else 0


def main():
    workflows = {p.name: p.read_text() for p in sorted(WORKFLOW_DIR.glob("*.yml"))}
    dependabot = (ROOT / ".github" / "dependabot.yml").read_text()
    contract = read_contract()
    if "--self-test" in sys.argv[1:]:
        return self_test(workflows, dependabot, contract)
    problems = check(workflows, dependabot, contract)
    for problem in problems:
        print(f"FAIL: {problem}")
    if not problems:
        print(f"ok: {len(workflows)} workflows satisfy the security invariants")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
