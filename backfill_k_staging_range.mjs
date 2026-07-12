name: backfill-k-staging-range

on:
  workflow_dispatch:
    inputs:
      start_date:
        description: "開始日 YYYY-MM-DD"
        required: true
        default: "2026-07-02"
      days:
        description: "日数。最大180日（半年）"
        required: true
        default: "7"
      dry:
        description: "true=DB保存なし / false=stagingへ保存"
        required: true
        default: "true"
        type: choice
        options:
          - "true"
          - "false"

jobs:
  backfill-k-staging-range:
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

      - name: run K backfill range to staging
        working-directory: pipeline
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
          CAPTURE_TARGET: staging
        run: node backfill_k_staging_range.mjs "${{ github.event.inputs.start_date }}" "${{ github.event.inputs.days }}" --dry="${{ github.event.inputs.dry }}"
