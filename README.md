# 確定済みレース一括取得API

追加API:

`/api/yoso?action=confirmed_results&date=YYYYMMDD`

必要ヘッダー:

`x-capture-token: CAPTURE_TOKEN`

レスポンス例:

```json
{
  "ok": true,
  "action": "confirmed_results",
  "count": 2,
  "confirmedKeys": ["桐生:1", "桐生:2"],
  "confirmedByVenue": {
    "桐生": [1, 2]
  }
}
```

判定方法:
- `race_results` を当日分だけ1回取得
- 1〜3着が重複なしで3件揃ったレースだけ確定済み扱い
- 確定済みレースを次回のパイプライン処理から除外するために使用
