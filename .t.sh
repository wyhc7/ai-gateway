#!/bin/bash
set -e
cd /tmp && rm -rf gwtest
git clone -q https://github.com/wyhc7/ai-gateway.git gwtest
cd gwtest
echo "当前提交: $(git log --oneline -1)"
echo "--- 先用当前代码跑，复现失败 ---"
cd server
node --test test/ownership.test.js test/update.test.js 2>&1 | grep -E '^ℹ (tests|pass|fail)' || node --test test/ownership.test.js test/update.test.js 2>&1 | tail -12