#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

npm -w @npmguard/shared run contract:export

cd engine
uv run datamodel-codegen \
  --input ../shared/contract/contract.schema.json \
  --input-file-type jsonschema \
  --output npmguard/contract/models.py \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.12 \
  --use-annotated \
  --use-union-operator \
  --use-standard-collections \
  --enum-field-as-literal all \
  --field-constraints \
  --use-default-kwarg \
  --collapse-root-models \
  --use-title-as-name \
  --use-schema-description \
  --disable-timestamp

echo "contract: regenerated engine/npmguard/contract/models.py"
