# .github/workflows/daily-ingest.yml
# 毎日 前日分のK票を自動取り込み。手動実行(workflow_dispatch)で日付指定も可。
name: daily-ingest

on:
  schedule:
    # UTC 22:00 = JST 07:00（前日のレースが確定した翌朝）。分は0で固定。
    - cron: "0 22 * * *"
  workflow_dispatch:
    inputs:
      date:
        description: "取り込む日付 YYYY-MM-DD（空なら前日）"
        required: false

jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      # LZH解凍ツール（lhasa）を入れる
      - name: install lha
        run: sudo apt-get update && sudo apt-get install -y lhasa

      - name: install deps
        working-directory: pipeline
        run: npm install iconv-lite

      - name: resolve date
        id: d
        run: |
          if [ -n "${{ github.event.inputs.date }}" ]; then
            echo "date=${{ github.event.inputs.date }}" >> $GITHUB_OUTPUT
          else
            # JST前日
            echo "date=$(TZ=Asia/Tokyo date -d 'yesterday' +%Y-%m-%d)" >> $GITHUB_OUTPUT
          fi

      - name: ingest K
        working-directory: pipeline
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
        run: node ingest_k.mjs ${{ steps.d.outputs.date }}
