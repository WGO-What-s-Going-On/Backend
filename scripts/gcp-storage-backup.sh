#!/bin/bash
set -euo pipefail
project=${GCP_PROJECT_ID:?GCP_PROJECT_ID required}
cluster=${GKE_CLUSTER:?GKE_CLUSTER required}
namespace=${K8S_NAMESPACE:?K8S_NAMESPACE required}
region=asia-northeast3
for value in "$project" "$cluster" "$namespace"; do [[ "$value" =~ ^[a-z][a-z0-9-]{2,62}$ ]] || exit 2; done
plan="$namespace-storage"
case "${1:-}" in
  create-plan)
    gcloud services enable gkebackup.googleapis.com --project "$project"
    gcloud container clusters update "$cluster" --region "$region" --project "$project" --update-addons=BackupRestore=ENABLED
    gcloud beta container backup-restore backup-plans create "$plan" --project "$project" --location "$region" \
      --cluster="projects/$project/locations/$region/clusters/$cluster" --selected-applications="$namespace/wgo-databases" \
      --include-volume-data --include-secrets --cron-schedule='0 18 * * *' --backup-retain-days=14
    ;;
  backup-now)
    backup=${2:?A unique backup name is required}
    gcloud beta container backup-restore backups create "$backup" --project "$project" --location "$region" --backup-plan "$plan"
    ;;
  create-restore-plan)
    target=${2:?A separate restore-test cluster is required}
    [[ "$target" != "$cluster" && "$target" =~ ^[a-z][a-z0-9-]{2,62}$ ]] || exit 2
    gcloud beta container backup-restore restore-plans create "$plan-restore-test" --project "$project" --location "$region" \
      --backup-plan="projects/$project/locations/$region/backupPlans/$plan" \
      --cluster="projects/$project/locations/$region/clusters/$target" --selected-applications="$namespace/wgo-databases" \
      --namespaced-resource-restore-mode=fail-on-conflict --cluster-resource-conflict-policy=use-existing-version \
      --cluster-resource-scope-no-group-kinds --volume-data-restore-policy=restore-volume-data-from-backup
    ;;
  restore-test)
    backup=${2:?Backup name required}
    restore=${3:?Unique restore name required}
    gcloud beta container backup-restore restores create "$restore" --project "$project" --location "$region" \
      --restore-plan="$plan-restore-test" --backup="projects/$project/locations/$region/backupPlans/$plan/backups/$backup"
    ;;
  *) echo 'Usage: gcp-storage-backup.sh create-plan|backup-now NAME|create-restore-plan TARGET_CLUSTER|restore-test BACKUP RESTORE' >&2; exit 2;;
esac
