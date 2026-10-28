#!/usr/bin/env bash
# One-time GCP bootstrap for gtfs-rt-debugger: everything Terraform cannot create for
# itself. Idempotent. See scripts/README.md.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<EOF
Usage: scripts/bootstrap.sh --project <project-id> --repo <owner/repo> [--region <region>] [--dry-run]

Prepares an existing, billing-linked GCP project for Terraform and GitHub Actions:
enables APIs, creates the versioned Terraform state bucket, the GitHub Workload
Identity Federation pool and provider, and the tf-plan / tf-apply identities with
their bindings. Run it as a project owner. Safe to re-run: it creates only what is
missing and never creates service-account keys.

Options:
  --project <project-id>  GCP project to bootstrap.              Env fallback: PROJECT_ID
  --repo <owner/repo>     The one GitHub repository allowed to
                          authenticate (exact case).             Env fallback: GITHUB_REPO
  --region <region>       Region for the state bucket and the
                          printed GitHub variable.               Env fallback: REGION (default: $DEFAULT_REGION)
  --dry-run               Print every change without making it (read-only checks still run).
  -h, --help              Show this help.

Flags take precedence over environment variables. Every change is printed before it
runs.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    if parse_common_flag "$@"; then
      shift "$FLAG_SHIFT"
      continue
    fi
    case $1 in
      -h | --help)
        usage
        exit 0
        ;;
      *) usage_error "unknown argument: $1" ;;
    esac
  done
}

verify_project() {
  step "Verifying project $PROJECT_ID"
  load_project
  [[ $PROJECT_STATE == ACTIVE ]] ||
    die "project '$PROJECT_ID' is $PROJECT_STATE, not ACTIVE"
  load_billing ||
    die "could not read the billing info of '$PROJECT_ID' (are you a project owner?)"
  if [[ $BILLING_ENABLED != True ]]; then
    die "billing is not linked to '$PROJECT_ID'. Link it first, then re-run:
    gcloud billing accounts list
    gcloud billing projects link $PROJECT_ID --billing-account=<ACCOUNT_ID>"
  fi
  log "project number $PROJECT_NUMBER, billing account $BILLING_ACCOUNT"
}

# api_ready <api>: whether probes against <api> can run now. Under --dry-run an API this
# run would enable is still disabled, so its resources are taken to be absent.
api_ready() {
  [[ $DRY_RUN == 0 ]] || api_enabled "$1"
}

# preflight: before changing anything, refuse resources bootstrap must never adopt. The
# same checks run again after the APIs are enabled.
preflight() {
  step "Checking existing resources"
  if api_enabled storage.googleapis.com; then
    check_bucket_adoptable
  fi
  if api_enabled iam.googleapis.com; then
    check_provider_conforms
  fi
  log "nothing in the way"
}

enable_apis() {
  step "Enabling APIs"
  local api missing=()
  for api in "${REQUIRED_APIS[@]}"; do
    api_enabled "$api" || missing+=("$api")
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    log "all required APIs are already enabled"
    return 0
  fi
  run gcloud services enable "${missing[@]}" --project="$PROJECT_ID"
}

adopt_bucket_command() {
  shell_quote gcloud storage buckets update "gs://$STATE_BUCKET" --versioning \
    --update-labels="$BOOTSTRAP_LABEL_KEY=$BOOTSTRAP_LABEL_VALUE"
}

# check_bucket_adoptable: dies if the state bucket exists without the bootstrap label and
# is not empty. Such a bucket holds someone else's data; labeling it would authorize
# teardown to delete it. An empty unlabeled bucket is what an interrupted run leaves.
check_bucket_adoptable() {
  if ! bucket_in_project || bucket_has_label || bucket_is_empty; then
    return 0
  fi
  die "gs://$STATE_BUCKET exists without the bootstrap label $BOOTSTRAP_LABEL_KEY=$BOOTSTRAP_LABEL_VALUE and is not empty; refusing to adopt it (the label lets teardown delete it with every version).
If it really is this app's Terraform state bucket, adopt it deliberately, then re-run bootstrap:
    $(adopt_bucket_command)"
}

ensure_state_bucket() {
  step "Terraform state bucket gs://$STATE_BUCKET"
  local label="$BOOTSTRAP_LABEL_KEY=$BOOTSTRAP_LABEL_VALUE"
  if ! api_ready storage.googleapis.com || ! bucket_in_project; then
    run gcloud storage buckets create "gs://$STATE_BUCKET" --project="$PROJECT_ID" \
      --location="$REGION" --uniform-bucket-level-access --public-access-prevention ||
      die "could not create gs://$STATE_BUCKET (bucket names are global: is it taken by another project?)"
    run gcloud storage buckets update "gs://$STATE_BUCKET" --versioning --update-labels="$label"
    return 0
  fi
  check_bucket_adoptable
  local updates=()
  bucket_versioning_enabled || updates+=(--versioning)
  if ! bucket_has_label; then
    log "exists, empty and unlabeled (left by an interrupted run): adopting it"
    updates+=("--update-labels=$label")
  fi
  if [[ ${#updates[@]} -eq 0 ]]; then
    log "exists, versioned and labeled"
    return 0
  fi
  run gcloud storage buckets update "gs://$STATE_BUCKET" "${updates[@]}"
}

PROVIDER_ARGS=()

# check_provider_conforms: dies if the provider exists (even soft-deleted) with a
# condition, issuer or attribute mapping other than the contract's. It is never reused.
check_provider_conforms() {
  load_provider_state
  if [[ -z $PROVIDER_STATE ]]; then
    return 0
  fi
  local out condition issuer mapping expected problems=()
  read_or_die out gcloud iam workload-identity-pools providers describe "${PROVIDER_ARGS[@]}" \
    --format='value(attributeCondition,oidc.issuerUri)'
  condition=${out%%$'\t'*}
  issuer=""
  if [[ $out == *$'\t'* ]]; then
    issuer=${out#*$'\t'}
  fi
  read_or_die mapping gcloud iam workload-identity-pools providers describe "${PROVIDER_ARGS[@]}" \
    --format='json(attributeMapping)'
  mapping=$(json_pairs <<<"$mapping" | sort)
  expected=$(tr ',' '\n' <<<"$WIF_ATTRIBUTE_MAPPING" | sort)

  if [[ $condition != "$WIF_ATTRIBUTE_CONDITION" ]]; then
    problems+=("attribute condition is \"${condition:-<none>}\", expected \"$WIF_ATTRIBUTE_CONDITION\"")
  fi
  if [[ $issuer != "$WIF_ISSUER_URI" ]]; then
    problems+=("issuer is \"${issuer:-<none>}\", expected \"$WIF_ISSUER_URI\"")
  fi
  if [[ $mapping != "$expected" ]]; then
    problems+=("attribute mapping is
${mapping:-<none>}
      expected
$expected")
  fi
  if [[ ${#problems[@]} -eq 0 ]]; then
    return 0
  fi
  local problem message="existing provider '$WIF_PROVIDER_ID' does not match the contract; bootstrap never reuses it:"
  for problem in "${problems[@]}"; do
    message+="
  - $problem"
  done
  die "$message
If you are sure it should be this app's provider, make it conform deliberately, then re-run bootstrap:
    $(shell_quote gcloud iam workload-identity-pools providers update-oidc "${PROVIDER_ARGS[@]}" \
      --issuer-uri="$WIF_ISSUER_URI" --attribute-mapping="$WIF_ATTRIBUTE_MAPPING" \
      --attribute-condition="$WIF_ATTRIBUTE_CONDITION")"
}

ensure_wif() {
  step "Workload Identity Federation pool '$WIF_POOL_ID' and provider '$WIF_PROVIDER_ID'"
  local pool_args=("$WIF_POOL_ID" --project="$PROJECT_ID" --location="$WIF_LOCATION")
  POOL_STATE=""
  PROVIDER_STATE=""
  if api_ready iam.googleapis.com; then
    load_pool_state
    check_provider_conforms
  fi
  case $POOL_STATE in
    "")
      run gcloud iam workload-identity-pools create "${pool_args[@]}" \
        --display-name="GitHub Actions" --description="GitHub Actions OIDC for $GITHUB_REPO"
      ;;
    DELETED) run gcloud iam workload-identity-pools undelete "${pool_args[@]}" ;;
    *) log "pool exists" ;;
  esac
  case $PROVIDER_STATE in
    "")
      run gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ARGS[@]}" \
        --display-name="GitHub" --issuer-uri="$WIF_ISSUER_URI" \
        --attribute-mapping="$WIF_ATTRIBUTE_MAPPING" \
        --attribute-condition="$WIF_ATTRIBUTE_CONDITION"
      ;;
    DELETED) run gcloud iam workload-identity-pools providers undelete "${PROVIDER_ARGS[@]}" ;;
    *) log "provider exists and matches the contract" ;;
  esac
}

# sa_present <email>: whether the service account exists (absent under --dry-run while
# the IAM API is not yet enabled).
sa_present() {
  api_ready iam.googleapis.com && service_account_exists "$1"
}

ensure_identities() {
  step "Terraform identities"
  if sa_present "$PLAN_SA_EMAIL"; then
    log "$PLAN_SA_EMAIL exists"
  else
    run gcloud iam service-accounts create "$PLAN_SA_ID" --project="$PROJECT_ID" \
      --display-name="Terraform plan (pull requests)" \
      --description="Read-only Terraform plan identity for $INFRA_WORKFLOW_PATH on pull requests"
  fi
  if sa_present "$APPLY_SA_EMAIL"; then
    log "$APPLY_SA_EMAIL exists"
  else
    run gcloud iam service-accounts create "$APPLY_SA_ID" --project="$PROJECT_ID" \
      --display-name="Terraform apply (main)" \
      --description="Terraform apply identity for $INFRA_WORKFLOW_PATH on main"
  fi
}

# ensure_binding <rows> <role> <member> <condition expression or ""> <add command...>:
# runs the add command unless exactly that binding exists. The command carries the
# matching --condition flag.
ensure_binding() {
  local rows=$1 role=$2 member=$3 expression=$4
  shift 4
  if has_binding "$rows" "$role" "$member" "$expression"; then
    log "binding exists: $role -> $member${expression:+ if $expression}"
    return 0
  fi
  run "$@" --member="$member" --role="$role"
}

ensure_bindings() {
  step "IAM bindings"
  local rows role
  read_or_die rows iam_rows gcloud projects get-iam-policy "$PROJECT_ID"
  local project_add=(gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None)
  for role in "${PLAN_PROJECT_ROLES[@]}"; do
    ensure_binding "$rows" "$role" "serviceAccount:$PLAN_SA_EMAIL" "" "${project_add[@]}"
  done
  for role in "${APPLY_PROJECT_ROLES[@]}"; do
    ensure_binding "$rows" "$role" "serviceAccount:$APPLY_SA_EMAIL" "" "${project_add[@]}"
  done

  # Under --dry-run the bucket and identities may not exist yet: their policies are empty.
  rows=""
  if api_ready storage.googleapis.com && bucket_in_project; then
    read_or_die rows iam_rows gcloud storage buckets get-iam-policy "gs://$STATE_BUCKET"
  fi
  local bucket_add=(gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET")
  ensure_binding "$rows" "$APPLY_STATE_ROLE" "serviceAccount:$APPLY_SA_EMAIL" "" \
    "${bucket_add[@]}" --condition=None
  ensure_binding "$rows" "$PLAN_STATE_READ_ROLE" "serviceAccount:$PLAN_SA_EMAIL" "" \
    "${bucket_add[@]}" --condition=None
  ensure_binding "$rows" "$PLAN_STATE_LOCK_ROLE" "serviceAccount:$PLAN_SA_EMAIL" \
    "$PLAN_STATE_LOCK_CONDITION_EXPRESSION" "${bucket_add[@]}" \
    --condition="expression=$PLAN_STATE_LOCK_CONDITION_EXPRESSION,title=$PLAN_STATE_LOCK_CONDITION_TITLE"

  ensure_wif_binding "$PLAN_SA_EMAIL" "$PLAN_WIF_MEMBER"
  ensure_wif_binding "$APPLY_SA_EMAIL" "$APPLY_WIF_MEMBER"
}

# ensure_wif_binding <service-account email> <principalSet member>
ensure_wif_binding() {
  local email=$1 member=$2 rows=""
  if sa_present "$email"; then
    read_or_die rows iam_rows gcloud iam service-accounts get-iam-policy "$email" --project="$PROJECT_ID"
  fi
  ensure_binding "$rows" "$WIF_USER_ROLE" "$member" "" \
    gcloud iam service-accounts add-iam-policy-binding "$email" --project="$PROJECT_ID" --condition=None
}

ensure_billing_permission() {
  step "Budget permission on billing account $BILLING_ACCOUNT"
  local grants=(
    "$APPLY_BILLING_ROLE serviceAccount:$APPLY_SA_EMAIL"
    "$PLAN_BILLING_ROLE serviceAccount:$PLAN_SA_EMAIL"
  )
  local rows grant role member manual=()
  if ! rows=$(iam_rows gcloud billing accounts get-iam-policy "$BILLING_ACCOUNT" 2>/dev/null); then
    manual=("${grants[@]}")
  else
    for grant in "${grants[@]}"; do
      role=${grant%% *}
      member=${grant#* }
      if has_binding "$rows" "$role" "$member"; then
        log "binding exists: $role -> $member"
      elif ! run gcloud billing accounts add-iam-policy-binding "$BILLING_ACCOUNT" \
        --member="$member" --role="$role"; then
        manual+=("$grant")
      fi
    done
  fi
  if [[ ${#manual[@]} -eq 0 ]]; then
    return 0
  fi
  warn "you cannot grant roles on billing account $BILLING_ACCOUNT. Ask a billing account administrator to run:"
  for grant in "${manual[@]}"; do
    printf '    %s\n' "$(shell_quote gcloud billing accounts add-iam-policy-binding "$BILLING_ACCOUNT" \
      --member="${grant#* }" --role="${grant%% *}")" >&2
  done
  warn "until then, run Terraform with -var=manage_budget=false (the budget is then not managed)"
}

print_summary() {
  if [[ $DRY_RUN == 1 ]]; then
    step "Dry run complete: nothing was changed"
  else
    step "Bootstrap complete"
  fi
  cat <<EOF

Set these GitHub repository variables (Settings > Secrets and variables > Actions >
Variables). No GitHub secrets are needed.
  $GH_VAR_PROJECT_ID     = $PROJECT_ID
  $GH_VAR_PROJECT_NUMBER = $PROJECT_NUMBER
  $GH_VAR_REGION         = $REGION
  $GH_VAR_STATE_BUCKET    = $STATE_BUCKET
or with the GitHub CLI:
  gh variable set $GH_VAR_PROJECT_ID --repo $GITHUB_REPO --body $PROJECT_ID
  gh variable set $GH_VAR_PROJECT_NUMBER --repo $GITHUB_REPO --body $PROJECT_NUMBER
  gh variable set $GH_VAR_REGION --repo $GITHUB_REPO --body $REGION
  gh variable set $GH_VAR_STATE_BUCKET --repo $GITHUB_REPO --body $STATE_BUCKET

For reference:
  Workload Identity provider  $WIF_PROVIDER_NAME
  Plan identity               $PLAN_SA_EMAIL
  Apply identity              $APPLY_SA_EMAIL
  Billing account             $BILLING_ACCOUNT

Next steps (see infra/README.md for the full variable list):
  1. First Terraform apply, locally, with your own credentials (gcloud auth application-default login):
       terraform -chdir=infra init -backend-config=bucket=$STATE_BUCKET
       terraform -chdir=infra apply -var=project_id=$PROJECT_ID -var=region=$REGION \\
         -var=github_repository=$GITHUB_REPO -var=wif_pool=$WIF_POOL_NAME \\
         -var=billing_account=$BILLING_ACCOUNT
  2. Add the three feed-URL secret values (gcloud secrets versions add; see infra/README.md).
  3. Merge to main: the pipelines take over from there.
EOF
}

main() {
  parse_args "$@"
  validate_project_id
  validate_repo
  validate_region
  require_gcloud
  if [[ $DRY_RUN == 1 ]]; then
    log "Dry run: printing changes without making them."
  fi

  init_scratch
  verify_project
  derive_names
  PROVIDER_ARGS=("$WIF_PROVIDER_ID" --project="$PROJECT_ID" --location="$WIF_LOCATION"
    --workload-identity-pool="$WIF_POOL_ID")
  load_enabled_apis
  preflight
  enable_apis
  ensure_state_bucket
  ensure_wif
  ensure_identities
  ensure_bindings
  ensure_billing_permission
  print_summary
}

main "$@"
