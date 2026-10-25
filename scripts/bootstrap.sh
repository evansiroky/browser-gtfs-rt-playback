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

enable_apis() {
  step "Enabling APIs"
  local enabled api missing=()
  enabled=$(gcloud services list --enabled --project="$PROJECT_ID" --format='value(config.name)') ||
    die "could not list the enabled APIs of '$PROJECT_ID'"
  for api in "${REQUIRED_APIS[@]}"; do
    grep -Fxq -- "$api" <<<"$enabled" || missing+=("$api")
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    log "all required APIs are already enabled"
    return 0
  fi
  run gcloud services enable "${missing[@]}" --project="$PROJECT_ID"
}

ensure_state_bucket() {
  step "Terraform state bucket gs://$STATE_BUCKET"
  local label="$BOOTSTRAP_LABEL_KEY=$BOOTSTRAP_LABEL_VALUE"
  if ! bucket_in_project; then
    run gcloud storage buckets create "gs://$STATE_BUCKET" --project="$PROJECT_ID" \
      --location="$REGION" --uniform-bucket-level-access --public-access-prevention ||
      die "could not create gs://$STATE_BUCKET (bucket names are global: is it taken by another project?)"
    run gcloud storage buckets update "gs://$STATE_BUCKET" --versioning --update-labels="$label"
    return 0
  fi
  local updates=()
  bucket_versioning_enabled || updates+=(--versioning)
  bucket_has_label || updates+=("--update-labels=$label")
  if [[ ${#updates[@]} -eq 0 ]]; then
    log "exists, versioned and labeled"
    return 0
  fi
  run gcloud storage buckets update "gs://$STATE_BUCKET" "${updates[@]}"
}

ensure_wif() {
  step "Workload Identity Federation pool '$WIF_POOL_ID' and provider '$WIF_PROVIDER_ID'"
  local pool_args=("$WIF_POOL_ID" --project="$PROJECT_ID" --location="$WIF_LOCATION")
  case $(pool_state) in
    "")
      run gcloud iam workload-identity-pools create "${pool_args[@]}" \
        --display-name="GitHub Actions" --description="GitHub Actions OIDC for $GITHUB_REPO"
      ;;
    DELETED) run gcloud iam workload-identity-pools undelete "${pool_args[@]}" ;;
    *) log "pool exists" ;;
  esac

  local provider_args=("$WIF_PROVIDER_ID" --project="$PROJECT_ID" --location="$WIF_LOCATION"
    --workload-identity-pool="$WIF_POOL_ID")
  case $(provider_state) in
    "")
      run gcloud iam workload-identity-pools providers create-oidc "${provider_args[@]}" \
        --display-name="GitHub" --issuer-uri="$WIF_ISSUER_URI" \
        --attribute-mapping="$WIF_ATTRIBUTE_MAPPING" \
        --attribute-condition="$WIF_ATTRIBUTE_CONDITION"
      return 0
      ;;
    DELETED) run gcloud iam workload-identity-pools providers undelete "${provider_args[@]}" ;;
    *) log "provider exists" ;;
  esac

  local condition
  condition=$(gcloud iam workload-identity-pools providers describe "${provider_args[@]}" \
    --format='value(attributeCondition)' 2>/dev/null) || condition=""
  if [[ -n $condition && $condition != "$WIF_ATTRIBUTE_CONDITION" ]]; then
    die "provider '$WIF_PROVIDER_ID' is restricted by \"$condition\", expected \"$WIF_ATTRIBUTE_CONDITION\".
Bootstrap does not change existing resources. If the repository moved, update it with:
    $(shell_quote gcloud iam workload-identity-pools providers update-oidc "${provider_args[@]}" \
      --attribute-condition="$WIF_ATTRIBUTE_CONDITION")"
  fi
}

ensure_identities() {
  step "Terraform identities"
  if service_account_exists "$PLAN_SA_EMAIL"; then
    log "$PLAN_SA_EMAIL exists"
  else
    run gcloud iam service-accounts create "$PLAN_SA_ID" --project="$PROJECT_ID" \
      --display-name="Terraform plan (pull requests)" \
      --description="Read-only Terraform plan identity for $INFRA_WORKFLOW_PATH on pull requests"
  fi
  if service_account_exists "$APPLY_SA_EMAIL"; then
    log "$APPLY_SA_EMAIL exists"
  else
    run gcloud iam service-accounts create "$APPLY_SA_ID" --project="$PROJECT_ID" \
      --display-name="Terraform apply (main)" \
      --description="Terraform apply identity for $INFRA_WORKFLOW_PATH on main"
  fi
}

# ensure_binding <rows> <role> <member> <add-iam-policy-binding command...>
ensure_binding() {
  local rows=$1 role=$2 member=$3
  shift 3
  if has_binding "$rows" "$role" "$member"; then
    log "binding exists: $role -> $member"
    return 0
  fi
  run "$@" --member="$member" --role="$role"
}

ensure_bindings() {
  step "IAM bindings"
  local rows role
  rows=$(iam_rows gcloud projects get-iam-policy "$PROJECT_ID") ||
    die "could not read the IAM policy of '$PROJECT_ID'"
  local project_add=(gcloud projects add-iam-policy-binding "$PROJECT_ID" --condition=None)
  for role in "${PLAN_PROJECT_ROLES[@]}"; do
    ensure_binding "$rows" "$role" "serviceAccount:$PLAN_SA_EMAIL" "${project_add[@]}"
  done
  for role in "${APPLY_PROJECT_ROLES[@]}"; do
    ensure_binding "$rows" "$role" "serviceAccount:$APPLY_SA_EMAIL" "${project_add[@]}"
  done

  # Under --dry-run the bucket and identities may not exist yet: their policies are empty.
  rows=""
  if bucket_in_project; then
    rows=$(iam_rows gcloud storage buckets get-iam-policy "gs://$STATE_BUCKET") ||
      die "could not read the IAM policy of gs://$STATE_BUCKET"
  fi
  local bucket_add=(gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET" --condition=None)
  ensure_binding "$rows" "$STATE_BUCKET_ROLE" "serviceAccount:$PLAN_SA_EMAIL" "${bucket_add[@]}"
  ensure_binding "$rows" "$STATE_BUCKET_ROLE" "serviceAccount:$APPLY_SA_EMAIL" "${bucket_add[@]}"

  ensure_wif_binding "$PLAN_SA_EMAIL" "$PLAN_WIF_MEMBER"
  ensure_wif_binding "$APPLY_SA_EMAIL" "$APPLY_WIF_MEMBER"
}

# ensure_wif_binding <service-account email> <principalSet member>
ensure_wif_binding() {
  local email=$1 member=$2 rows=""
  if service_account_exists "$email"; then
    rows=$(iam_rows gcloud iam service-accounts get-iam-policy "$email" --project="$PROJECT_ID") ||
      die "could not read the IAM policy of $email"
  fi
  ensure_binding "$rows" "$WIF_USER_ROLE" "$member" \
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

  verify_project
  derive_names
  enable_apis
  ensure_state_bucket
  ensure_wif
  ensure_identities
  ensure_bindings
  ensure_billing_permission
  print_summary
}

main "$@"
