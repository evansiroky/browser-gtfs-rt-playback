# shellcheck shell=bash
# shellcheck disable=SC2034  # constants are consumed by bootstrap.sh and teardown.sh
#
# Shared helpers and the naming contract for bootstrap.sh and teardown.sh.
# Sourced, never executed. Keep the constants below byte-for-byte in sync with the
# "Naming contract" table in scripts/README.md: Terraform (infra/) and the GitHub
# workflows hardcode the same values.
#
# Compatible with bash 3.2 (macOS): no associative arrays, and possibly-empty arrays
# are never expanded bare under `set -u`.

set -euo pipefail

# Every mutating gcloud call runs only after this script's own confirmation, so
# gcloud's interactive prompts are disabled (equivalent to --quiet on each call).
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

# ---- Naming contract -------------------------------------------------------------

readonly DEFAULT_REGION="us-west1"

# State bucket: "<project-id>-tfstate", versioned, uniform bucket-level access,
# carrying the bootstrap label (teardown deletes it only if the label is present).
readonly STATE_BUCKET_SUFFIX="-tfstate"
readonly BOOTSTRAP_LABEL_KEY="gtfs-rt-debugger-bootstrap"
readonly BOOTSTRAP_LABEL_VALUE="true"

# Workload Identity Federation.
readonly WIF_LOCATION="global"
readonly WIF_POOL_ID="github"
readonly WIF_PROVIDER_ID="github"
readonly WIF_ISSUER_URI="https://token.actions.githubusercontent.com"
readonly WIF_ATTRIBUTE_MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.target=assertion.job_workflow_ref.split('@')[0] + ':' + (assertion.event_name == 'pull_request' ? 'pr' : assertion.ref)"
# The attribute condition is "assertion.repository == '<owner>/<repo>'" (see derive_names).

# Terraform identities. Each is impersonable only by the infra workflow on one target:
#   principalSet://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/github/attribute.target/<owner>/<repo>/.github/workflows/infra.yml:<target>
readonly INFRA_WORKFLOW_PATH=".github/workflows/infra.yml"
readonly PLAN_SA_ID="tf-plan"
readonly PLAN_TARGET="pr"
readonly APPLY_SA_ID="tf-apply"
readonly APPLY_TARGET="refs/heads/main"
readonly WIF_USER_ROLE="roles/iam.workloadIdentityUser"

PLAN_PROJECT_ROLES=(
  "roles/viewer"
  "roles/iam.securityReviewer"
)
APPLY_PROJECT_ROLES=(
  "roles/run.admin"
  "roles/artifactregistry.admin"
  "roles/secretmanager.admin"
  "roles/iam.serviceAccountAdmin"
  "roles/iam.serviceAccountUser"
  "roles/serviceusage.serviceUsageConsumer"
)
# Granted on the state bucket only, to both identities (state read/write and lock).
readonly STATE_BUCKET_ROLE="roles/storage.objectAdmin"
# Granted on the project's billing account, when the operator is able to grant them.
readonly APPLY_BILLING_ROLE="roles/billing.costsManager"
readonly PLAN_BILLING_ROLE="roles/billing.viewer"

REQUIRED_APIS=(
  "run.googleapis.com"
  "artifactregistry.googleapis.com"
  "secretmanager.googleapis.com"
  "iam.googleapis.com"
  "iamcredentials.googleapis.com"
  "sts.googleapis.com"
  "cloudresourcemanager.googleapis.com"
  "serviceusage.googleapis.com"
  "billingbudgets.googleapis.com"
  "storage.googleapis.com"
)
# Arrays are made read-only separately: `readonly name=(...)` misbehaves in bash 3.2.
readonly PLAN_PROJECT_ROLES APPLY_PROJECT_ROLES REQUIRED_APIS

# GitHub repository variables bootstrap prints for the operator to set.
readonly GH_VAR_PROJECT_ID="GCP_PROJECT_ID"
readonly GH_VAR_PROJECT_NUMBER="GCP_PROJECT_NUMBER"
readonly GH_VAR_REGION="GCP_REGION"
readonly GH_VAR_STATE_BUCKET="TF_STATE_BUCKET"

# ---- Inputs ----------------------------------------------------------------------

PROJECT_ID=${PROJECT_ID:-}
REGION=${REGION:-$DEFAULT_REGION}
GITHUB_REPO=${GITHUB_REPO:-}
DRY_RUN=0
FLAG_SHIFT=0

usage_error() {
  printf 'error: %s\n(run with --help for usage)\n' "$1" >&2
  exit 2
}

# need_value <flag> <args...>: exits with a usage error unless "--flag value" has a value.
need_value() {
  if [[ $# -lt 2 || -z $2 || $2 == --* ]]; then
    usage_error "$1 requires a value"
  fi
}

# parse_common_flag <args...>: consumes one flag shared by both scripts and sets
# FLAG_SHIFT to the number of arguments it used. Returns 1 for any other argument.
parse_common_flag() {
  case $1 in
    --project) need_value "$@"; PROJECT_ID=$2; FLAG_SHIFT=2 ;;
    --project=*) PROJECT_ID=${1#*=}; FLAG_SHIFT=1 ;;
    --region) need_value "$@"; REGION=$2; FLAG_SHIFT=2 ;;
    --region=*) REGION=${1#*=}; FLAG_SHIFT=1 ;;
    --repo) need_value "$@"; GITHUB_REPO=$2; FLAG_SHIFT=2 ;;
    --repo=*) GITHUB_REPO=${1#*=}; FLAG_SHIFT=1 ;;
    --dry-run) DRY_RUN=1; FLAG_SHIFT=1 ;;
    *) return 1 ;;
  esac
}

validate_project_id() {
  [[ -n $PROJECT_ID ]] ||
    usage_error "missing project ID: pass --project <project-id> or set PROJECT_ID"
  local re='^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
  [[ $PROJECT_ID =~ $re ]] ||
    usage_error "'$PROJECT_ID' is not a valid project ID (6-30 characters: lowercase letters, digits, hyphens; starts with a letter)"
}

validate_region() {
  local re='^[a-z]+-[a-z]+[0-9]+$'
  [[ $REGION =~ $re ]] ||
    usage_error "'$REGION' is not a valid region (for example $DEFAULT_REGION): pass --region <region> or set REGION"
}

validate_repo() {
  [[ -n $GITHUB_REPO ]] ||
    usage_error "missing GitHub repository: pass --repo <owner/repo> or set GITHUB_REPO"
  local re='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$'
  if [[ ! $GITHUB_REPO =~ $re || $GITHUB_REPO == */. || $GITHUB_REPO == */.. ]]; then
    usage_error "GitHub repository must be a full owner/repo such as octocat/hello-world (exact case), got '$GITHUB_REPO'"
  fi
}

require_gcloud() {
  command -v gcloud >/dev/null 2>&1 ||
    die "gcloud not found on PATH: install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install)"
}

# ---- Output ----------------------------------------------------------------------

log() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# shell_quote <args...>: prints the arguments as a copy-pasteable shell command.
shell_quote() {
  local arg out="" re='^[A-Za-z0-9_./:=@,+%-]+$' q="'"
  for arg in "$@"; do
    if [[ $arg =~ $re ]]; then
      out+=" $arg"
    else
      out+=" '${arg//$q/$q\\$q$q}'"
    fi
  done
  printf '%s' "${out# }"
}

# run <command...>: prints a mutating command, then runs it (or only prints it under
# --dry-run). Read-only probes are not passed through run.
run() {
  if [[ $DRY_RUN == 1 ]]; then
    printf '[dry-run] %s\n' "$(shell_quote "$@")"
    return 0
  fi
  printf '+ %s\n' "$(shell_quote "$@")"
  "$@"
}

# ---- Project and derived names ---------------------------------------------------

PROJECT_NUMBER=""
PROJECT_STATE=""
BILLING_ENABLED=""
BILLING_ACCOUNT=""

# load_project: sets PROJECT_STATE and PROJECT_NUMBER, or dies if the project is not
# visible to the active gcloud account.
load_project() {
  local out
  out=$(gcloud projects describe "$PROJECT_ID" --format='value(lifecycleState,projectNumber)' 2>/dev/null) ||
    die "project '$PROJECT_ID' does not exist or is not visible to the active gcloud account (check 'gcloud auth list'; create the project first)"
  PROJECT_STATE=${out%%$'\t'*}
  PROJECT_NUMBER=${out##*$'\t'}
  [[ -n $PROJECT_NUMBER && $PROJECT_NUMBER != "$out" ]] ||
    die "could not read the project number of '$PROJECT_ID'"
}

# load_billing: sets BILLING_ENABLED ("True" when linked) and BILLING_ACCOUNT (the
# bare account ID). Returns 1 if the billing info cannot be read.
load_billing() {
  local out
  out=$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled,billingAccountName)' 2>/dev/null) ||
    return 1
  BILLING_ENABLED=${out%%$'\t'*}
  BILLING_ACCOUNT=""
  if [[ $out == *$'\t'* ]]; then
    BILLING_ACCOUNT=${out#*$'\t'}
    BILLING_ACCOUNT=${BILLING_ACCOUNT#billingAccounts/}
  fi
}

# derive_names: every bootstrap resource name, from PROJECT_ID, PROJECT_NUMBER and
# GITHUB_REPO.
derive_names() {
  STATE_BUCKET="${PROJECT_ID}${STATE_BUCKET_SUFFIX}"
  PLAN_SA_EMAIL="${PLAN_SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
  APPLY_SA_EMAIL="${APPLY_SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
  WIF_POOL_NAME="projects/${PROJECT_NUMBER}/locations/${WIF_LOCATION}/workloadIdentityPools/${WIF_POOL_ID}"
  WIF_PROVIDER_NAME="${WIF_POOL_NAME}/providers/${WIF_PROVIDER_ID}"
  WIF_ATTRIBUTE_CONDITION="assertion.repository == '${GITHUB_REPO}'"
  PLAN_WIF_MEMBER="principalSet://iam.googleapis.com/${WIF_POOL_NAME}/attribute.target/${GITHUB_REPO}/${INFRA_WORKFLOW_PATH}:${PLAN_TARGET}"
  APPLY_WIF_MEMBER="principalSet://iam.googleapis.com/${WIF_POOL_NAME}/attribute.target/${GITHUB_REPO}/${INFRA_WORKFLOW_PATH}:${APPLY_TARGET}"
}

# ---- Probes (read-only; never passed through run) --------------------------------

# iam_rows <get-iam-policy command...>: prints one "role<TAB>member" line per binding
# member.
iam_rows() {
  "$@" --flatten='bindings[].members' --format='value(bindings.role,bindings.members)'
}

# has_binding <rows> <role> <member>
has_binding() {
  grep -Fxq -- "$2"$'\t'"$3" <<<"$1"
}

# bucket_in_project: whether the state bucket exists in this project.
bucket_in_project() {
  local names
  names=$(gcloud storage buckets list --project="$PROJECT_ID" --format='value(name)' 2>/dev/null) ||
    die "could not list the Cloud Storage buckets of '$PROJECT_ID'"
  grep -Fxq -- "$STATE_BUCKET" <<<"$names"
}

bucket_has_label() {
  local labels
  labels=$(gcloud storage buckets describe "gs://$STATE_BUCKET" --format='json(labels)' 2>/dev/null) || return 1
  grep -Fq -- "\"$BOOTSTRAP_LABEL_KEY\": \"$BOOTSTRAP_LABEL_VALUE\"" <<<"$labels"
}

bucket_versioning_enabled() {
  local enabled
  enabled=$(gcloud storage buckets describe "gs://$STATE_BUCKET" --format='value(versioning_enabled)' 2>/dev/null) || return 1
  [[ $enabled == True ]]
}

service_account_exists() {
  gcloud iam service-accounts describe "$1" --project="$PROJECT_ID" --format='value(email)' >/dev/null 2>&1
}

# pool_state / provider_state: print ACTIVE, DELETED (soft-deleted for 30 days), or
# nothing when the resource does not exist.
pool_state() {
  gcloud iam workload-identity-pools describe "$WIF_POOL_ID" \
    --project="$PROJECT_ID" --location="$WIF_LOCATION" --format='value(state)' 2>/dev/null || true
}

provider_state() {
  gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_ID" \
    --project="$PROJECT_ID" --location="$WIF_LOCATION" --workload-identity-pool="$WIF_POOL_ID" \
    --format='value(state)' 2>/dev/null || true
}
