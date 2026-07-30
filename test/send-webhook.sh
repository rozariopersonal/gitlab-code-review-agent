#!/usr/bin/env bash
set -euo pipefail

echo "Sending test webhook to reviewer..."
curl -s -X POST http://localhost:3000/webhook/gitlab \
  -H "Content-Type: application/json" \
  -d @test/webhook-payload.json | jq .

echo ""
echo "Check the reviewer logs for the review output."
