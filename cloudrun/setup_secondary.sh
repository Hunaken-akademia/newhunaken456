#!/usr/bin/env bash
set -euo pipefail

REGION="${REGION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-hunaken-jobs}"
IMAGE_NAME="${IMAGE_NAME:-capture-all-active-races-secondary}"
JOB_NAME="${JOB_NAME:-hunaken-capture-secondary}"
RUNNER_SA_NAME="${RUNNER_SA_NAME:-hunaken-capture-runner}"
SCHEDULER_SA_NAME="${SCHEDULER_SA_NAME:-hunaken-capture-scheduler}"
SECRET_CAPTURE_TOKEN="${SECRET_CAPTURE_TOKEN:-hunaken-capture-token}"
SECRET_AUTH_SESSION="${SECRET_AUTH_SESSION:-hunaken-automation-auth-session}"

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  read -r -p "Google CloudのプロジェクトID: " PROJECT_ID
fi
if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_IDが必要です" >&2
  exit 1
fi

gcloud config set project "${PROJECT_ID}" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
RUNNER_SA="${RUNNER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA="${SCHEDULER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:latest"

read -r -p "舟券アカデミア本番URL（例 https://xxxx.vercel.app）: " APP_BASE_URL
APP_BASE_URL="${APP_BASE_URL%/}"
read -r -s -p "CAPTURE_TOKEN（GitHubと同じ値）: " CAPTURE_TOKEN_VALUE
echo
read -r -s -p "AUTOMATION_AUTH_SESSION_JSON（{ から } まで）: " AUTH_SESSION_VALUE
echo

if [[ -z "${APP_BASE_URL}" || -z "${CAPTURE_TOKEN_VALUE}" || -z "${AUTH_SESSION_VALUE}" ]]; then
  echo "URL・CAPTURE_TOKEN・AUTOMATION_AUTH_SESSION_JSONはすべて必要です" >&2
  exit 1
fi

python - <<'PY' "${AUTH_SESSION_VALUE}"
import json, sys
value = sys.argv[1]
obj = json.loads(value)
if not obj.get("access_token"):
    raise SystemExit("AUTOMATION_AUTH_SESSION_JSONにaccess_tokenがありません")
print("AUTOMATION_AUTH_SESSION_JSON: JSON形式OK")
PY

echo "必要なGoogle Cloud APIを有効化します..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com >/dev/null

if ! gcloud artifacts repositories describe "${REPOSITORY}" --location "${REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="舟券アカデミア副系ジョブ"
fi

# Cloud Buildの既定サービスアカウントがArtifact Registryへpushできるようにする。
for BUILD_SA in \
  "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"; do
  gcloud artifacts repositories add-iam-policy-binding "${REPOSITORY}" \
    --location="${REGION}" \
    --member="serviceAccount:${BUILD_SA}" \
    --role="roles/artifactregistry.writer" >/dev/null 2>&1 || true
done

for SA_NAME in "${RUNNER_SA_NAME}" "${SCHEDULER_SA_NAME}"; do
  if ! gcloud iam service-accounts describe "${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${SA_NAME}" --display-name="${SA_NAME}"
  fi
done

upsert_secret() {
  local name="$1"
  local value="$2"
  if ! gcloud secrets describe "${name}" >/dev/null 2>&1; then
    gcloud secrets create "${name}" --replication-policy=automatic >/dev/null
  fi
  printf '%s' "${value}" | gcloud secrets versions add "${name}" --data-file=- >/dev/null
  gcloud secrets add-iam-policy-binding "${name}" \
    --member="serviceAccount:${RUNNER_SA}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
}

upsert_secret "${SECRET_CAPTURE_TOKEN}" "${CAPTURE_TOKEN_VALUE}"
upsert_secret "${SECRET_AUTH_SESSION}" "${AUTH_SESSION_VALUE}"

echo "Cloud Buildで副系コンテナを作成します..."
gcloud builds submit \
  --config="cloudrun/cloudbuild-secondary.yaml" \
  --substitutions="_REGION=${REGION},_REPOSITORY=${REPOSITORY},_IMAGE=${IMAGE_NAME}" \
  .

echo "Cloud Run Jobを作成・更新します..."
gcloud run jobs deploy "${JOB_NAME}" \
  --image="${IMAGE_URI}" \
  --region="${REGION}" \
  --service-account="${RUNNER_SA}" \
  --tasks=1 \
  --max-retries=1 \
  --task-timeout=20m \
  --cpu=1 \
  --memory=2Gi \
  --set-env-vars="APP_BASE_URL=${APP_BASE_URL},RUNNER_NAME=cloud-run-secondary,PRIMARY_RUNNER_NAME=github-actions-primary,SECONDARY_RUNNER_NAME=cloud-run-secondary,PRIMARY_MAX_AGE_MINUTES=7,RUNNING_MAX_AGE_MINUTES=20,CAPTURE_CONCURRENCY=5,AI_CAPTURE_CONCURRENCY=2,AI_SAVE_BEFORE_MINUTES=20" \
  --set-secrets="CAPTURE_TOKEN=${SECRET_CAPTURE_TOKEN}:latest,AUTOMATION_AUTH_SESSION_JSON=${SECRET_AUTH_SESSION}:latest"

gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
  --region="${REGION}" \
  --member="serviceAccount:${SCHEDULER_SA}" \
  --role="roles/run.invoker" >/dev/null

RUN_URI="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}:run"

upsert_scheduler() {
  local name="$1"
  local schedule="$2"
  if gcloud scheduler jobs describe "${name}" --location="${REGION}" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "${name}" \
      --location="${REGION}" \
      --schedule="${schedule}" \
      --time-zone="Asia/Tokyo" \
      --uri="${RUN_URI}" \
      --http-method=POST \
      --oauth-service-account-email="${SCHEDULER_SA}" \
      --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
      --headers="Content-Type=application/json" \
      --message-body='{}' >/dev/null
  else
    gcloud scheduler jobs create http "${name}" \
      --location="${REGION}" \
      --schedule="${schedule}" \
      --time-zone="Asia/Tokyo" \
      --uri="${RUN_URI}" \
      --http-method=POST \
      --oauth-service-account-email="${SCHEDULER_SA}" \
      --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
      --headers="Content-Type=application/json" \
      --message-body='{}' >/dev/null
  fi
}

# GitHubは毎時02,07,12...分。副系は00,05,10...分に監視し、主系が新しければ処理をスキップする。
upsert_scheduler "hunaken-capture-secondary-day" "*/5 7-23 * * *"
upsert_scheduler "hunaken-capture-secondary-midnight" "*/5 0 * * *"

echo
echo "設定完了"
echo "Project: ${PROJECT_ID}"
echo "Region : ${REGION}"
echo "Job    : ${JOB_NAME}"
echo "副系はJST 07:00〜翌00:55に5分ごとに起動し、主系が7分以内に成功していれば自動スキップします。"
echo
echo "まず通常監視のテストを実行します（主系が新しければSKIPで正常です）:"
echo "gcloud run jobs execute ${JOB_NAME} --region=${REGION} --wait"
echo
echo "副系の本体処理まで強制テストする場合はREADME_完全二重化.mdを確認してください。"
