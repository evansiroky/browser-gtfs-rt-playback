#!/usr/bin/env bash
# Test harness for scripts/bootstrap.sh and scripts/teardown.sh. Runs both scripts
# against a fake gcloud (test/fake-bin) and a fake terraform (test/fake-tf) with a
# minimal PATH, so nothing real is ever called. Usage: scripts/test/run-tests.sh
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPTS=$(dirname "$HERE")
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-tests.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT

# The scripts under test run from a copy of the repo layout (scripts/ next to an
# infra/ directory), so the tests do not depend on the real infra/.
SUT=$ROOT/repo/scripts
mkdir -p "$SUT" "$ROOT/repo/infra"
cp "$SCRIPTS/lib.sh" "$SCRIPTS/bootstrap.sh" "$SCRIPTS/teardown.sh" "$SUT/"

# Only these tools are visible to the scripts under test, besides the fakes.
TOOLS=$ROOT/tools
mkdir -p "$TOOLS"
for tool in bash env cat grep sed mkdir rm ls mv touch sort tr dirname; do
  ln -s "$(command -v "$tool")" "$TOOLS/$tool"
done

PROJECT="test-project-1"
NUMBER=123456789012
REPO=octo-org/gtfs-rt-debugger
ACCOUNT=AAAAAA-BBBBBB-CCCCCC
BUCKET=$PROJECT-tfstate
PLAN_SA=tf-plan@$PROJECT.iam.gserviceaccount.com
APPLY_SA=tf-apply@$PROJECT.iam.gserviceaccount.com
POOL=projects/$NUMBER/locations/global/workloadIdentityPools/github
# Contract values written out literally (not read from lib.sh) on purpose.
MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.target=assertion.job_workflow_ref.split('@')[0] + ':' + (assertion.event_name == 'pull_request' ? 'pr' : assertion.ref)"
CONDITION="assertion.repository == '$REPO'"
PLAN_MEMBER="principalSet://iam.googleapis.com/$POOL/attribute.target/$REPO/.github/workflows/infra.yml:pr"
APPLY_MEMBER="principalSet://iam.googleapis.com/$POOL/attribute.target/$REPO/.github/workflows/infra.yml:refs/heads/main"
TAB=$'\t'

# ---- Fixture ---------------------------------------------------------------------

W=""
S=""
LOG=""
OUT=""
RC=0

# new_project: a fresh, billing-linked project with nothing bootstrapped.
new_project() {
  W=$(mktemp -d "$ROOT/case.XXXXXX")
  S=$W/state
  LOG=$W/calls.log
  OUT=$W/out
  mkdir -p "$S"
  : >"$LOG"
  echo "$PROJECT" >"$S/project_id"
  echo "$NUMBER" >"$S/project_number"
  echo ACTIVE >"$S/lifecycle"
  echo True >"$S/billing_enabled"
  echo "billingAccounts/$ACCOUNT" >"$S/billing_account"
  echo serviceusage.googleapis.com >"$S/services"
  printf 'roles/owner\tuser:operator@example.com\n' >"$S/project_iam"
}

# invoke [VAR=value ...] <script> [args...]: runs scripts/<script> with only the given
# environment. INPUT (if set) is fed on stdin; NO_TERRAFORM=1 hides the fake terraform.
invoke() {
  local envs=()
  while [[ $1 == *=* ]]; do
    envs+=("$1")
    shift
  done
  local script=$1
  shift
  local path="$HERE/fake-bin:$HERE/fake-tf:$TOOLS"
  if [[ ${NO_TERRAFORM:-0} == 1 ]]; then
    path="$HERE/fake-bin:$TOOLS"
  fi
  : >"$LOG"
  set +e
  env -i HOME="$W" PATH="$path" FAKE_STATE="$S" FAKE_LOG="$LOG" FAKE_TF_FAIL="${FAKE_TF_FAIL:-}" \
    ${envs[@]+"${envs[@]}"} "$SUT/$script" "$@" <<<"${INPUT:-}" >"$OUT" 2>&1
  RC=$?
  set -e
  cat "$LOG" >>"$ROOT/all-calls.log"
  if grep -q '^unsupported' "$LOG"; then
    fail "$script made a call the fake gcloud does not implement: $(grep '^unsupported' "$LOG")"
  fi
}

bootstrap_ok() {
  invoke bootstrap.sh --project "$PROJECT" --repo "$REPO"
  assert_rc 0
}

# ---- Assertions ------------------------------------------------------------------

fail() {
  printf '    FAIL: %s\n' "$*"
  if [[ -n $OUT && -s $OUT ]]; then
    printf '    --- script output ---\n'
    sed 's/^/    | /' "$OUT"
  fi
  if [[ -n $LOG && -s $LOG ]]; then
    printf '    --- calls ---\n'
    sed 's/^/    | /' "$LOG"
  fi
  exit 1
}

assert_rc() { [[ $RC == "$1" ]] || fail "exit code $RC, expected $1"; }
assert_out() { grep -Fq -- "$1" "$OUT" || fail "output lacks: $1"; }
assert_not_out() { ! grep -Fq -- "$1" "$OUT" || fail "output unexpectedly has: $1"; }
assert_called() { grep -Fq -- "$1" "$LOG" || fail "no call matching: $1"; }
assert_not_called() { ! grep -Fq -- "$1" "$LOG" || fail "unexpected call matching: $1"; }
assert_no_mutations() {
  ! grep -q '^mutate ' "$LOG" || fail "expected no mutating calls, got: $(grep '^mutate ' "$LOG")"
}
assert_no_calls() { [[ ! -s $LOG ]] || fail "expected no calls at all, got: $(cat "$LOG")"; }
assert_file() { [[ -e $S/$1 ]] || fail "expected state $1 to exist"; }
assert_no_file() { [[ ! -e $S/$1 ]] || fail "expected state $1 to be gone"; }
assert_content() { [[ $(cat "$S/$1") == "$2" ]] || fail "state $1 is '$(cat "$S/$1")', expected '$2'"; }
assert_row() { grep -Fxq -- "$2$TAB$3" "$S/$1" || fail "state $1 lacks binding $2 -> $3"; }
assert_no_row() { ! grep -Fq -- "$2" "$S/$1" 2>/dev/null || fail "state $1 still references $2"; }

# assert_order <pattern>...: each pattern's first mutating call comes after the previous one's.
assert_order() {
  local pattern line last=0
  for pattern in "$@"; do
    line=$(grep -n '^mutate ' "$LOG" | grep -F -- "$pattern" | head -n 1 | sed 's/:.*//')
    [[ -n $line ]] || fail "no mutating call matching: $pattern"
    [[ $line -gt $last ]] || fail "'$pattern' (call $line) ran before the previous step (call $last)"
    last=$line
  done
}

# ---- bootstrap.sh ----------------------------------------------------------------

test_bootstrap_creates_everything_in_order() {
  new_project
  bootstrap_ok
  assert_order "services enable" "storage buckets create gs://$BUCKET" "storage buckets update gs://$BUCKET" \
    "workload-identity-pools create github" "providers create-oidc github" \
    "service-accounts create tf-plan" "service-accounts create tf-apply" \
    "projects add-iam-policy-binding" "storage buckets add-iam-policy-binding" \
    "service-accounts add-iam-policy-binding" "billing accounts add-iam-policy-binding"
  local api
  for api in run artifactregistry secretmanager iam iamcredentials sts cloudresourcemanager serviceusage billingbudgets storage; do
    grep -Fxq "$api.googleapis.com" "$S/services" || fail "API $api.googleapis.com not enabled"
  done
  assert_not_called "cloudbuild"
  assert_called "storage buckets create gs://$BUCKET --project=$PROJECT --location=us-west1 --uniform-bucket-level-access --public-access-prevention"
  assert_called "storage buckets update gs://$BUCKET --versioning --update-labels=gtfs-rt-debugger-bootstrap=true"
  assert_content "buckets/$BUCKET/versioning" True
  assert_content "buckets/$BUCKET/labels" "gtfs-rt-debugger-bootstrap=true"
  assert_content pool ACTIVE
  assert_content provider ACTIVE
  assert_content provider_issuer "https://token.actions.githubusercontent.com"
  assert_content provider_mapping "$MAPPING"
  assert_content provider_condition "$CONDITION"
  assert_file "sa/$PLAN_SA"
  assert_file "sa/$APPLY_SA"
  assert_row "sa/$PLAN_SA.iam" roles/iam.workloadIdentityUser "$PLAN_MEMBER"
  assert_row "sa/$APPLY_SA.iam" roles/iam.workloadIdentityUser "$APPLY_MEMBER"
  [[ $(wc -l <"$S/sa/$PLAN_SA.iam") -eq 1 && $(wc -l <"$S/sa/$APPLY_SA.iam") -eq 1 ]] ||
    fail "each identity must be impersonable by exactly one principal set"
  local role
  for role in roles/viewer roles/iam.securityReviewer; do
    assert_row project_iam "$role" "serviceAccount:$PLAN_SA"
  done
  for role in roles/run.admin roles/artifactregistry.admin roles/secretmanager.admin roles/iam.serviceAccountAdmin \
    roles/iam.serviceAccountUser roles/serviceusage.serviceUsageConsumer; do
    assert_row project_iam "$role" "serviceAccount:$APPLY_SA"
  done
  [[ $(grep -c "serviceAccount:$PLAN_SA" "$S/project_iam") -eq 2 ]] || fail "tf-plan has extra project roles"
  ! grep -Eq 'roles/(owner|editor)' <(grep 'serviceAccount:' "$S/project_iam") || fail "an identity got owner/editor"
  ! grep -q 'storage' "$S/project_iam" || fail "storage roles must be on the state bucket only"
  assert_row "buckets/$BUCKET/iam" roles/storage.objectAdmin "serviceAccount:$PLAN_SA"
  assert_row "buckets/$BUCKET/iam" roles/storage.objectAdmin "serviceAccount:$APPLY_SA"
  assert_row billing_iam roles/billing.costsManager "serviceAccount:$APPLY_SA"
  assert_row billing_iam roles/billing.viewer "serviceAccount:$PLAN_SA"
  # Printed GitHub variables and next steps.
  assert_out "GCP_PROJECT_ID     = $PROJECT"
  assert_out "GCP_PROJECT_NUMBER = $NUMBER"
  assert_out "GCP_REGION         = us-west1"
  assert_out "TF_STATE_BUCKET    = $BUCKET"
  assert_out "$POOL/providers/github"
  assert_out "terraform -chdir=infra init -backend-config=bucket=$BUCKET"
  assert_out "gcloud secrets versions add"
}

test_bootstrap_prints_each_change_before_running_it() {
  new_project
  bootstrap_ok
  assert_out "+ gcloud services enable"
  # The printed command is copy-pasteable: it parses back into the exact arguments.
  local line printed=()
  line=$(grep -F '+ gcloud iam workload-identity-pools providers create-oidc' "$OUT") ||
    fail "provider creation was not printed"
  eval "printed=(${line#+ })"
  [[ " ${printed[*]} " == *" --attribute-mapping=$MAPPING "* ]] || fail "printed mapping does not round-trip"
  [[ " ${printed[*]} " == *" --attribute-condition=$CONDITION "* ]] || fail "printed condition does not round-trip"
  local mutations printed
  mutations=$(grep -c '^mutate ' "$LOG")
  printed=$(grep -c '^+ gcloud ' "$OUT")
  [[ $mutations -eq $printed ]] || fail "$mutations mutating calls but $printed printed commands"
}

test_bootstrap_rerun_is_idempotent() {
  new_project
  bootstrap_ok
  bootstrap_ok
  assert_no_mutations
  assert_out "all required APIs are already enabled"
  assert_out "exists, versioned and labeled"
}

test_bootstrap_completes_a_partial_run() {
  new_project
  # As if a first run stopped right after creating the bucket and the pool.
  mkdir -p "$S/buckets/$BUCKET"
  echo ACTIVE >"$S/pool"
  bootstrap_ok
  assert_not_called "storage buckets create"
  assert_not_called "workload-identity-pools create github"
  assert_called "storage buckets update gs://$BUCKET --versioning --update-labels=gtfs-rt-debugger-bootstrap=true"
  assert_called "providers create-oidc github"
  bootstrap_ok
  assert_no_mutations
}

test_bootstrap_restores_soft_deleted_pool_and_provider() {
  new_project
  bootstrap_ok
  echo DELETED >"$S/pool"
  echo DELETED >"$S/provider"
  bootstrap_ok
  assert_called "workload-identity-pools undelete github"
  assert_called "providers undelete github"
  assert_not_called " create"
  assert_content pool ACTIVE
}

test_bootstrap_dry_run_changes_nothing() {
  new_project
  invoke bootstrap.sh --project "$PROJECT" --repo "$REPO" --dry-run
  assert_rc 0
  assert_no_mutations
  assert_out "[dry-run] gcloud services enable"
  assert_out "[dry-run] gcloud storage buckets create gs://$BUCKET"
  assert_out "[dry-run] gcloud iam service-accounts add-iam-policy-binding $PLAN_SA"
  assert_out "Dry run complete: nothing was changed"
  assert_no_file buckets
  assert_no_file pool
}

test_bootstrap_requires_linked_billing() {
  new_project
  echo False >"$S/billing_enabled"
  invoke bootstrap.sh --project "$PROJECT" --repo "$REPO"
  assert_rc 1
  assert_out "billing is not linked"
  assert_out "gcloud billing projects link $PROJECT --billing-account=<ACCOUNT_ID>"
  assert_no_mutations
}

test_bootstrap_without_billing_permission_prints_the_commands() {
  new_project
  touch "$S/billing_denied"
  bootstrap_ok
  assert_not_called "billing accounts add-iam-policy-binding"
  assert_out "Ask a billing account administrator to run:"
  assert_out "gcloud billing accounts add-iam-policy-binding $ACCOUNT --member=serviceAccount:$APPLY_SA --role=roles/billing.costsManager"
  assert_out "gcloud billing accounts add-iam-policy-binding $ACCOUNT --member=serviceAccount:$PLAN_SA --role=roles/billing.viewer"
}

test_bootstrap_refuses_a_provider_bound_to_another_repo() {
  new_project
  bootstrap_ok
  echo "assertion.repository == 'someone/else'" >"$S/provider_condition"
  invoke bootstrap.sh --project "$PROJECT" --repo "$REPO"
  assert_rc 1
  assert_out "expected \"$CONDITION\""
  assert_out "providers update-oidc"
  assert_no_mutations
}

test_bootstrap_bucket_name_taken_elsewhere() {
  new_project
  echo "$BUCKET" >"$S/foreign_buckets"
  invoke bootstrap.sh --project "$PROJECT" --repo "$REPO"
  assert_rc 1
  assert_out "is it taken by another project?"
  assert_not_called "workload-identity-pools create"
}

test_bootstrap_reads_environment_fallbacks() {
  new_project
  invoke PROJECT_ID="$PROJECT" GITHUB_REPO="$REPO" REGION=europe-west4 bootstrap.sh
  assert_rc 0
  assert_called "--location=europe-west4"
  assert_out "GCP_REGION         = europe-west4"
  # Flags win over the environment.
  invoke PROJECT_ID=wrong-project GITHUB_REPO=bad bootstrap.sh --project="$PROJECT" --repo="$REPO"
  assert_rc 0
}

test_bootstrap_rejects_bad_inputs() {
  new_project
  invoke bootstrap.sh --repo "$REPO"
  assert_rc 2
  assert_out "missing project ID: pass --project <project-id> or set PROJECT_ID"
  assert_no_calls
  local repo
  for repo in gtfs-rt-debugger octo-org/ /gtfs-rt-debugger octo-org/a/b https://github.com/octo-org/gtfs-rt-debugger "octo org/x" -octo/x octo/..; do
    invoke bootstrap.sh --project "$PROJECT" --repo "$repo"
    assert_rc 2
    assert_out "GitHub repository must be a full owner/repo"
    assert_no_calls
  done
  invoke bootstrap.sh --project "$PROJECT"
  assert_rc 2
  assert_out "missing GitHub repository: pass --repo <owner/repo> or set GITHUB_REPO"
  invoke bootstrap.sh --project "Bad_Project" --repo "$REPO"
  assert_rc 2
  assert_out "is not a valid project ID"
  invoke bootstrap.sh --project "$PROJECT" --repo "$REPO" --region "us west"
  assert_rc 2
  invoke bootstrap.sh --project
  assert_rc 2
  assert_out "--project requires a value"
  invoke bootstrap.sh --project "$PROJECT" --repo "$REPO" --bogus
  assert_rc 2
  assert_out "unknown argument: --bogus"
  # Well-formed, but no such project.
  invoke bootstrap.sh --project other-project-9 --repo "$REPO"
  assert_rc 1
  assert_out "project 'other-project-9' does not exist or is not visible"
  assert_no_mutations
}

test_bootstrap_help_documents_flags_and_env() {
  new_project
  invoke bootstrap.sh --help
  assert_rc 0
  local word
  for word in --project --repo --region --dry-run --help PROJECT_ID GITHUB_REPO REGION us-west1; do
    assert_out "$word"
  done
  assert_no_calls
}

# ---- teardown.sh -----------------------------------------------------------------

teardown_args=(--project "$PROJECT" --repo "$REPO")

test_teardown_refuses_without_confirmation() {
  new_project
  bootstrap_ok
  INPUT="" invoke teardown.sh "${teardown_args[@]}"
  assert_rc 1
  assert_out "Type the project ID to confirm:"
  assert_out "nothing was changed"
  assert_no_mutations
  INPUT="test-project" invoke teardown.sh "${teardown_args[@]}"
  assert_rc 1
  assert_no_mutations
  invoke teardown.sh "${teardown_args[@]}" --confirm-project other-project-9
  assert_rc 1
  assert_no_mutations
  assert_file "sa/$PLAN_SA"
}

test_teardown_dry_run_changes_nothing() {
  new_project
  bootstrap_ok
  invoke teardown.sh "${teardown_args[@]}" --dry-run --delete-project
  assert_rc 0
  assert_no_mutations
  assert_not_out "Type the project ID"
  assert_out "[dry-run] terraform -chdir="
  assert_out "[dry-run] gcloud iam service-accounts delete $PLAN_SA"
  assert_out "[dry-run] gcloud iam workload-identity-pools delete github"
  assert_out "[dry-run] gcloud storage rm --recursive gs://$BUCKET"
  assert_out "[dry-run] gcloud projects delete $PROJECT"
  assert_file "buckets/$BUCKET"
  assert_content lifecycle ACTIVE
}

test_teardown_removes_everything_in_order() {
  new_project
  bootstrap_ok
  # A role added by hand later must go too.
  printf 'roles/logging.viewer\tserviceAccount:%s\n' "$APPLY_SA" >>"$S/project_iam"
  INPUT="$PROJECT" invoke teardown.sh "${teardown_args[@]}"
  assert_rc 0
  assert_order "init -input=false" "destroy -input=false" \
    "projects remove-iam-policy-binding" "billing accounts remove-iam-policy-binding" \
    "service-accounts delete $PLAN_SA" "service-accounts delete $APPLY_SA" \
    "providers delete github" "workload-identity-pools delete github" "storage rm --recursive gs://$BUCKET"
  assert_called "init -input=false -reconfigure -backend-config=bucket=$BUCKET"
  assert_called "destroy -input=false -auto-approve | TF_VAR_billing_account=$ACCOUNT TF_VAR_github_repository=$REPO TF_VAR_project_id=$PROJECT TF_VAR_region=us-west1 TF_VAR_wif_pool=$POOL"
  assert_no_row project_iam "$PLAN_SA"
  assert_no_row project_iam "$APPLY_SA"
  assert_row project_iam roles/owner user:operator@example.com
  assert_no_row billing_iam "$PLAN_SA"
  assert_no_row billing_iam "$APPLY_SA"
  assert_no_file "sa/$PLAN_SA"
  assert_no_file "sa/$APPLY_SA"
  assert_content provider DELETED
  assert_content pool DELETED
  assert_no_file "buckets/$BUCKET"
  assert_content lifecycle ACTIVE
  assert_not_called "projects delete"
  assert_out "Teardown complete"
}

test_teardown_rerun_tolerates_already_gone() {
  new_project
  bootstrap_ok
  invoke teardown.sh "${teardown_args[@]}" --confirm-project "$PROJECT"
  assert_rc 0
  invoke teardown.sh "${teardown_args[@]}" --confirm-project "$PROJECT"
  assert_rc 0
  assert_no_mutations
  assert_out "already gone"
  assert_out "no Terraform state to destroy"
  # A never-bootstrapped project is fine too.
  new_project
  invoke teardown.sh --project "$PROJECT" --skip-terraform --confirm-project "$PROJECT"
  assert_rc 0
  assert_no_mutations
}

test_teardown_tolerates_partial_state() {
  new_project
  bootstrap_ok
  rm "$S/sa/$PLAN_SA"
  echo DELETED >"$S/provider"
  invoke teardown.sh --project "$PROJECT" --skip-terraform --confirm-project "$PROJECT"
  assert_rc 0
  assert_out "$PLAN_SA already gone"
  assert_out "provider already gone"
  assert_called "service-accounts delete $APPLY_SA"
  assert_called "workload-identity-pools delete github"
  assert_no_file "buckets/$BUCKET"
}

test_teardown_never_deletes_an_unlabeled_bucket() {
  new_project
  bootstrap_ok
  : >"$S/buckets/$BUCKET/labels"
  invoke teardown.sh --project "$PROJECT" --skip-terraform --confirm-project "$PROJECT"
  assert_rc 0
  assert_out "does not carry the label gtfs-rt-debugger-bootstrap=true"
  assert_not_called "storage rm"
  assert_file "buckets/$BUCKET"
  # A different label value is not bootstrap's label either.
  echo "gtfs-rt-debugger-bootstrap=false" >"$S/buckets/$BUCKET/labels"
  invoke teardown.sh --project "$PROJECT" --skip-terraform --confirm-project "$PROJECT"
  assert_not_called "storage rm"
  assert_file "buckets/$BUCKET"
}

test_teardown_skip_terraform() {
  new_project
  bootstrap_ok
  invoke teardown.sh --project "$PROJECT" --skip-terraform --confirm-project "$PROJECT"
  assert_rc 0
  assert_not_called "terraform"
  assert_out "skipped (--skip-terraform)"
}

test_teardown_stops_if_terraform_destroy_fails() {
  new_project
  bootstrap_ok
  FAKE_TF_FAIL=destroy invoke teardown.sh "${teardown_args[@]}" --confirm-project "$PROJECT"
  assert_rc 1
  assert_not_called "mutate gcloud"
  assert_file "sa/$APPLY_SA"
  assert_file "buckets/$BUCKET"
}

test_teardown_requires_infra_dir_unless_skipped() {
  new_project
  bootstrap_ok
  mv "$ROOT/repo/infra" "$ROOT/repo/infra.moved"
  invoke teardown.sh "${teardown_args[@]}" --confirm-project "$PROJECT"
  mv "$ROOT/repo/infra.moved" "$ROOT/repo/infra"
  assert_rc 1
  assert_out "no Terraform configuration at"
  assert_no_mutations
}

test_teardown_requires_terraform_unless_skipped() {
  new_project
  bootstrap_ok
  NO_TERRAFORM=1 invoke teardown.sh "${teardown_args[@]}" --confirm-project "$PROJECT"
  assert_rc 1
  assert_out "terraform not found on PATH"
  assert_no_mutations
}

test_teardown_delete_project_needs_second_confirmation() {
  new_project
  bootstrap_ok
  INPUT="$PROJECT" invoke teardown.sh --project "$PROJECT" --skip-terraform --delete-project
  assert_rc 1
  assert_out "Type the project ID again to confirm:"
  assert_no_mutations
  invoke teardown.sh --project "$PROJECT" --skip-terraform --delete-project \
    --confirm-project "$PROJECT" --confirm-delete-project wrong-project
  assert_rc 1
  assert_no_mutations
  INPUT=$(printf '%s\n%s' "$PROJECT" "$PROJECT") invoke teardown.sh --project "$PROJECT" --skip-terraform --delete-project
  assert_rc 0
  assert_order "service-accounts delete" "storage rm --recursive" "projects delete $PROJECT"
  [[ $(grep '^mutate ' "$LOG" | tail -n 1) == *"projects delete $PROJECT"* ]] || fail "project deletion must be last"
  assert_content lifecycle DELETE_REQUESTED
  # Already shut down: nothing to do.
  invoke teardown.sh --project "$PROJECT" --skip-terraform --delete-project \
    --confirm-project "$PROJECT" --confirm-delete-project "$PROJECT"
  assert_rc 0
  assert_out "is DELETE_REQUESTED; nothing to tear down"
  assert_no_mutations
}

test_teardown_without_billing_permission_prints_the_commands() {
  new_project
  bootstrap_ok
  touch "$S/billing_denied"
  invoke teardown.sh --project "$PROJECT" --skip-terraform --confirm-project "$PROJECT"
  assert_rc 0
  assert_out "gcloud billing accounts remove-iam-policy-binding $ACCOUNT --member=serviceAccount:$APPLY_SA --role=roles/billing.costsManager"
  assert_not_called "billing accounts remove-iam-policy-binding"
}

test_teardown_rejects_bad_inputs() {
  new_project
  invoke teardown.sh --repo "$REPO" --confirm-project "$PROJECT"
  assert_rc 2
  assert_out "missing project ID"
  assert_no_calls
  invoke teardown.sh --project "$PROJECT" --repo "octo-org" --confirm-project "$PROJECT"
  assert_rc 2
  assert_out "GitHub repository must be a full owner/repo"
  assert_no_calls
  invoke teardown.sh --project "$PROJECT" --skip-terraform --repo "a/b/c" --confirm-project "$PROJECT"
  assert_rc 2
  assert_no_calls
  invoke teardown.sh --project "$PROJECT" --confirm-project "$PROJECT"
  assert_rc 2
  assert_out "missing GitHub repository"
  invoke teardown.sh --project "$PROJECT" --skip-terraform --confirm-delete-project "$PROJECT"
  assert_rc 2
  assert_out "--confirm-delete-project requires --delete-project"
  invoke teardown.sh --project other-project-9 --skip-terraform --confirm-project other-project-9
  assert_rc 1
  assert_out "does not exist or is not visible"
  assert_no_mutations
}

test_teardown_help_documents_flags_and_env() {
  new_project
  invoke teardown.sh --help
  assert_rc 0
  local word
  for word in --project --repo --region --confirm-project --skip-terraform --delete-project \
    --confirm-delete-project --dry-run --help PROJECT_ID GITHUB_REPO REGION; do
    assert_out "$word"
  done
  assert_no_calls
}

# ---- Static checks ---------------------------------------------------------------

test_no_service_account_keys_anywhere() {
  if grep -rn --exclude-dir=test -e 'keys create' -e 'keys upload' "$SCRIPTS"; then
    fail "scripts must never create service-account keys"
  fi
}

test_readme_contract_matches_lib_constants() {
  local readme=$SCRIPTS/README.md value spans
  [[ -f $readme ]] || fail "scripts/README.md is missing"
  # Every contract value must appear inside a `code span` of the README.
  # shellcheck disable=SC2016  # the backticks are literal
  spans=$(grep -o '`[^`]*`' "$readme")
  # shellcheck source=scripts/lib.sh
  source "$SCRIPTS/lib.sh"
  for value in "$STATE_BUCKET_SUFFIX" "$BOOTSTRAP_LABEL_KEY=$BOOTSTRAP_LABEL_VALUE" "$WIF_LOCATION" \
    "$WIF_POOL_ID" "$WIF_PROVIDER_ID" "$WIF_ISSUER_URI" "$WIF_ATTRIBUTE_MAPPING" "$INFRA_WORKFLOW_PATH" \
    "$PLAN_SA_ID" "$APPLY_SA_ID" ":$PLAN_TARGET" ":$APPLY_TARGET" "$WIF_USER_ROLE" "$STATE_BUCKET_ROLE" \
    "$APPLY_BILLING_ROLE" "$PLAN_BILLING_ROLE" "$GH_VAR_PROJECT_ID" "$GH_VAR_PROJECT_NUMBER" \
    "$GH_VAR_REGION" "$GH_VAR_STATE_BUCKET" "$DEFAULT_REGION" \
    "${PLAN_PROJECT_ROLES[@]}" "${APPLY_PROJECT_ROLES[@]}" "${REQUIRED_APIS[@]}"; do
    grep -Fq -- "$value" <<<"$spans" || fail "README.md does not document $value"
  done
  # Templated values, rendered the way lib.sh's derive_names builds them.
  PROJECT_ID="<project-id>" PROJECT_NUMBER="<project-number>" GITHUB_REPO="<owner>/<repo>"
  derive_names
  for value in "$STATE_BUCKET" "$PLAN_SA_EMAIL" "$APPLY_SA_EMAIL" "$WIF_POOL_NAME" "$WIF_PROVIDER_NAME" \
    "$WIF_ATTRIBUTE_CONDITION" "$PLAN_WIF_MEMBER" "$APPLY_WIF_MEMBER"; do
    grep -Fxq -- "\`$value\`" <<<"$spans" || fail "README.md lacks the exact value \`$value\`"
  done
}

# ---- Runner ----------------------------------------------------------------------

passed=0
failed=0
for test in $(declare -F | sed -n 's/^declare -f \(test_.*\)/\1/p'); do
  if (set -euo pipefail; "$test"); then
    printf 'ok   %s\n' "$test"
    passed=$((passed + 1))
  else
    printf 'FAIL %s\n' "$test"
    failed=$((failed + 1))
  fi
done

if grep -Eq 'keys (create|upload)' "$ROOT/all-calls.log" 2>/dev/null; then
  printf 'FAIL a script tried to create a service-account key\n'
  failed=$((failed + 1))
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ $failed -eq 0 ]]
