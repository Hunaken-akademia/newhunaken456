#!/usr/bin/env bash
set -euo pipefail

SECRET_AUTH_SESSION="${SECRET_AUTH_SESSION:-hunaken-automation-auth-session}"
read -r -s -p "新しいAUTOMATION_AUTH_SESSION_JSON（{ から } まで）: " AUTH_SESSION_VALUE
echo

AUTH_SESSION_VALUE="${AUTH_SESSION_VALUE}" python - <<'PY'
import json, os
value = os.environ.get("AUTH_SESSION_VALUE", "")
obj = json.loads(value)
if not obj.get("access_token"):
    raise SystemExit("access_tokenがありません")
print("JSON形式OK")
PY

printf '%s' "${AUTH_SESSION_VALUE}" | gcloud secrets versions add "${SECRET_AUTH_SESSION}" --data-file=- >/dev/null
echo "Secret Managerの ${SECRET_AUTH_SESSION}:latest を更新しました。次回のCloud Run実行から使われます。"
