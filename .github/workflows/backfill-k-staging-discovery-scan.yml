name: backfill-k-staging-discovery-scan

on:
  workflow_dispatch:
    inputs:
      start_date:
        description: "開始日 YYYY-MM-DD"
        required: true
        default: "2026-01-01"
      days:
        description: "洗い出す日数。最大180日"
        required: true
        default: "30"

jobs:
  discovery-scan:
    runs-on: ubuntu-latest
    timeout-minutes: 360
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: install lha
        run: sudo apt-get update && sudo apt-get install -y lhasa

      - name: install deps
        working-directory: pipeline
        run: npm install iconv-lite --no-save

      - name: scan K backfill range without DB write
        working-directory: pipeline
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
          CAPTURE_TARGET: staging
        run: node backfill_k_staging_range.mjs "${{ github.event.inputs.start_date }}" "${{ github.event.inputs.days }}" --dry="true" --continue-on-error="true"
