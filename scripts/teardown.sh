#!/usr/bin/env bash
# Removes gtfs-rt-debugger from its GCP project: terraform destroy, then everything
# bootstrap.sh created. Safe to re-run. See scripts/README.md.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "$SCRIPT_DIR/lib.sh"

INFRA_DIR="$(dirname "$SCRIPT_DIR")/infra"
CONFIRM_PROJECT=""
CONFIRM_DELETE_PROJECT=""
SKIP_TERRAFORM=0
DELETE_PROJECT=0

usage() {
  cat <<EOF
Usage: scripts/teardown.sh --project <project-id> [--repo <owner/repo>] [--region <region>]
                           [--confirm-project <project-id>] [--skip-terraform]
                           [--delete-project [--confirm-delete-project <project-id>]]
                           [--dry-run]

Removes the app from its project. Unless --skip-terraform is given, it first runs
'terraform destroy' (in infra/) against the project's state. It then removes what
bootstrap.sh created, found by bootstrap's fixed names: the tf-plan / tf-apply
bindings and identities, the Workload Identity Federation provider and pool, and the
Terraform state bucket with all object versions (only if it carries bootstrap's
label). Resources that are already gone are skipped. The project and its billing link
are left alone unless --delete-project is given.

You must confirm by typing the project ID (or pass --confirm-project).

Options:
  --project <project-id>     Project to tear down.                 Env fallback: PROJECT_ID
  --repo <owner/repo>        GitHub repository, passed to Terraform
                             as github_repository. Required unless
                             --skip-terraform.                     Env fallback: GITHUB_REPO
  --region <region>          Passed to Terraform as region.        Env fallback: REGION (default: $DEFAULT_REGION)
  --confirm-project <id>     Confirm non-interactively; must equal the project ID.
  --skip-terraform           Do not run terraform destroy (Terraform-managed resources
                             are then left in place unless --delete-project).
  --delete-project           Also shut down the whole project. Asks for a second
                             confirmation.
  --confirm-delete-project <id>
                             Give the second confirmation non-interactively; must equal
                             the project ID.
  --dry-run                  Print what would be deleted without deleting anything
                             (no confirmation needed; read-only checks still run).
  -h, --help                 Show this help.

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
      --confirm-project)
        need_value "$@"
        CONFIRM_PROJECT=$2
        shift 2
        ;;
      --confirm-project=*)
        CONFIRM_PROJECT=${1#*=}
        shift
        ;;
      --confirm-delete-project)
        need_value "$@"
        CONFIRM_DELETE_PROJECT=$2
        shift 2
        ;;
      --confirm-delete-project=*)
        CONFIRM_DELETE_PROJECT=${1#*=}
        shift
        ;;
      --skip-terraform)
        SKIP_TERRAFORM=1
        shift
        ;;
      --delete-project)
        DELETE_PROJECT=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) usage_error "unknown argument: $1" ;;
    esac
  done
}

validate_inputs() {
  validate_project_id
  if [[ $SKIP_TERRAFORM == 0 || -n $GITHUB_REPO ]]; then
    validate_repo
  fi
  validate_region
  if [[ -n $CONFIRM_DELETE_PROJECT && $DELETE_PROJECT == 0 ]]; then
    usage_error "--confirm-delete-project requires --delete-project"
  fi
}

# confirm <pre-supplied answer> <prompt>: succeeds only if the answer (given, or typed
# on stdin) is exactly the project ID.
confirm() {
  local answer=$1
  if [[ -z $answer ]]; then
    printf '%s' "$2" >&2
    IFS= read -r answer || answer=""
  fi
  [[ $answer == "$PROJECT_ID" ]]
}

require_confirmation() {
  if [[ $DRY_RUN == 1 ]]; then
    log "Dry run: printing what would be deleted; nothing is changed."
    return 0
  fi
  confirm "$CONFIRM_PROJECT" "This deletes gtfs-rt-debugger from project '$PROJECT_ID'. Type the project ID to confirm: " ||
    die "confirmation did not match '$PROJECT_ID'; nothing was changed"
  if [[ $DELETE_PROJECT == 1 ]]; then
    confirm "$CONFIRM_DELETE_PROJECT" "--delete-project shuts down the ENTIRE project '$PROJECT_ID', including anything not created by this app. Type the project ID again to confirm: " ||
      die "second confirmation did not match '$PROJECT_ID'; nothing was changed"
  fi
}

terraform_destroy() {
  step "Terraform destroy"
  if [[ $SKIP_TERRAFORM == 1 ]]; then
    log "skipped (--skip-terraform)"
    return 0
  fi
  if ! bucket_in_project; then
    warn "state bucket gs://$STATE_BUCKET does not exist, so there is no Terraform state to destroy from; Terraform-managed resources still in the project must be removed by hand (or with --delete-project)"
    return 0
  fi
  [[ -d $INFRA_DIR ]] ||
    die "no Terraform configuration at $INFRA_DIR; pass --skip-terraform to remove only the bootstrap resources"
  if ! command -v terraform >/dev/null 2>&1; then
    [[ $DRY_RUN == 1 ]] ||
      die "terraform not found on PATH; install it, or pass --skip-terraform to leave Terraform-managed resources in place"
    warn "terraform not found on PATH; a real run would fail here"
  fi
  # TF_VAR_* (not -var) so variables the configuration does not declare are ignored.
  export TF_VAR_project_id="$PROJECT_ID"
  export TF_VAR_region="$REGION"
  export TF_VAR_github_repository="$GITHUB_REPO"
  export TF_VAR_wif_pool="$WIF_POOL_NAME"
  log "with TF_VAR_project_id=$PROJECT_ID TF_VAR_region=$REGION TF_VAR_github_repository=$GITHUB_REPO TF_VAR_wif_pool=$WIF_POOL_NAME"
  if [[ -n $BILLING_ACCOUNT ]]; then
    export TF_VAR_billing_account="$BILLING_ACCOUNT"
    log "with TF_VAR_billing_account=$BILLING_ACCOUNT"
  fi
  run terraform -chdir="$INFRA_DIR" init -input=false -reconfigure -backend-config="bucket=$STATE_BUCKET"
  run terraform -chdir="$INFRA_DIR" destroy -input=false -auto-approve
}

# remove_member_bindings <rows> <member> <remove-iam-policy-binding command...>:
# removes every binding of <member> listed in <rows>, whatever its role.
remove_member_bindings() {
  local rows=$1 member=$2 role row_member found=0
  shift 2
  while IFS=$'\t' read -r -u 3 role row_member; do
    [[ $row_member == "$member" ]] || continue
    found=1
    run "$@" --member="$member" --role="$role"
  done 3<<<"$rows"
  if [[ $found == 0 ]]; then
    log "no bindings for $member"
  fi
}

remove_bindings() {
  step "IAM bindings of $PLAN_SA_ID and $APPLY_SA_ID"
  local rows
  rows=$(iam_rows gcloud projects get-iam-policy "$PROJECT_ID") ||
    die "could not read the IAM policy of '$PROJECT_ID'"
  local project_remove=(gcloud projects remove-iam-policy-binding "$PROJECT_ID" --condition=None)
  remove_member_bindings "$rows" "serviceAccount:$PLAN_SA_EMAIL" "${project_remove[@]}"
  remove_member_bindings "$rows" "serviceAccount:$APPLY_SA_EMAIL" "${project_remove[@]}"

  # Bindings on the identities and on the state bucket go away with those resources.
  if [[ -z $BILLING_ACCOUNT ]]; then
    log "no billing account linked; no billing bindings to remove"
    return 0
  fi
  if ! rows=$(iam_rows gcloud billing accounts get-iam-policy "$BILLING_ACCOUNT" 2>/dev/null); then
    warn "cannot read the IAM policy of billing account $BILLING_ACCOUNT; a billing account administrator can remove these bindings by hand:"
    printf '    %s\n' \
      "$(shell_quote gcloud billing accounts remove-iam-policy-binding "$BILLING_ACCOUNT" \
        --member="serviceAccount:$APPLY_SA_EMAIL" --role="$APPLY_BILLING_ROLE")" \
      "$(shell_quote gcloud billing accounts remove-iam-policy-binding "$BILLING_ACCOUNT" \
        --member="serviceAccount:$PLAN_SA_EMAIL" --role="$PLAN_BILLING_ROLE")" >&2
    return 0
  fi
  local billing_remove=(gcloud billing accounts remove-iam-policy-binding "$BILLING_ACCOUNT")
  remove_member_bindings "$rows" "serviceAccount:$PLAN_SA_EMAIL" "${billing_remove[@]}"
  remove_member_bindings "$rows" "serviceAccount:$APPLY_SA_EMAIL" "${billing_remove[@]}"
}

delete_identities() {
  step "Terraform identities"
  local email
  for email in "$PLAN_SA_EMAIL" "$APPLY_SA_EMAIL"; do
    if service_account_exists "$email"; then
      run gcloud iam service-accounts delete "$email" --project="$PROJECT_ID"
    else
      log "$email already gone"
    fi
  done
}

delete_wif() {
  step "Workload Identity Federation provider '$WIF_PROVIDER_ID' and pool '$WIF_POOL_ID'"
  case $(provider_state) in
    "" | DELETED) log "provider already gone" ;;
    *)
      run gcloud iam workload-identity-pools providers delete "$WIF_PROVIDER_ID" --project="$PROJECT_ID" \
        --location="$WIF_LOCATION" --workload-identity-pool="$WIF_POOL_ID"
      ;;
  esac
  case $(pool_state) in
    "" | DELETED) log "pool already gone" ;;
    *)
      run gcloud iam workload-identity-pools delete "$WIF_POOL_ID" --project="$PROJECT_ID" \
        --location="$WIF_LOCATION"
      ;;
  esac
}

delete_state_bucket() {
  step "Terraform state bucket gs://$STATE_BUCKET"
  if ! bucket_in_project; then
    log "already gone"
    return 0
  fi
  if ! bucket_has_label; then
    warn "gs://$STATE_BUCKET does not carry the label $BOOTSTRAP_LABEL_KEY=$BOOTSTRAP_LABEL_VALUE, so bootstrap did not create it; leaving it untouched"
    return 0
  fi
  # --recursive deletes every object version, then the bucket.
  run gcloud storage rm --recursive "gs://$STATE_BUCKET"
}

delete_project() {
  if [[ $DELETE_PROJECT == 0 ]]; then
    return 0
  fi
  step "Project $PROJECT_ID"
  run gcloud projects delete "$PROJECT_ID"
}

main() {
  parse_args "$@"
  validate_inputs
  require_gcloud

  step "Checking project $PROJECT_ID"
  load_project
  if [[ $PROJECT_STATE != ACTIVE ]]; then
    log "project '$PROJECT_ID' is $PROJECT_STATE; nothing to tear down"
    return 0
  fi
  load_billing || warn "could not read the billing info of '$PROJECT_ID'; billing bindings will be left alone"
  derive_names
  require_confirmation

  terraform_destroy
  remove_bindings
  delete_identities
  delete_wif
  delete_state_bucket
  delete_project

  if [[ $DRY_RUN == 1 ]]; then
    step "Dry run complete: nothing was changed"
  else
    step "Teardown complete"
  fi
}

main "$@"
