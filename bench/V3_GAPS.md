# NpmGuard Benchmark V3 Gaps

_Derived from the 143 Datadog audit reports copied from Hetzner on
2026-06-30._

This file separates infrastructure gaps from security misses. Timeouts should
not be treated as SAFE misses, and SAFE misses should not be hidden as infra.

## Timeout Rows

These 19 rows returned `null` verdicts with `polling timed out after
1800000ms`.

| Fixture | Category | Package |
| --- | --- | --- |
| `test-pkg-bench-dd-c-ansi-regex-v6.2.1` | `datadog-compromised` | `ansi-regex@6.2.1` |
| `test-pkg-bench-dd-c-automation_model-v1.0.491` | `datadog-compromised` | `automation_model@1.0.491` |
| `test-pkg-bench-dd-c-backslash-v0.2.1` | `datadog-compromised` | `backslash@0.2.1` |
| `test-pkg-bench-dd-c-compare-obj-v1.1.1` | `datadog-compromised` | `compare-obj@1.1.1` |
| `test-pkg-bench-dd-c-dialogflow-es-v1.1.2` | `datadog-compromised` | `dialogflow-es@1.1.2` |
| `test-pkg-bench-dd-c-eslint-config-prettier-v10.1.7` | `datadog-compromised` | `eslint-config-prettier@10.1.7` |
| `test-pkg-bench-dd-c-oradm-to-sqlz-v1.1.4` | `datadog-compromised` | `oradm-to-sqlz@1.1.4` |
| `test-pkg-bench-dd-c-ove-auto-annotate-v0.0.10` | `datadog-compromised` | `ove-auto-annotate@0.0.10` |
| `test-pkg-bench-dd-c-react-jam-icons-v1.0.2` | `datadog-compromised` | `react-jam-icons@1.0.2` |
| `test-pkg-bench-dd-c-swc-plugin-component-annotate-v1.9.2` | `datadog-compromised` | `swc-plugin-component-annotate@1.9.2` |
| `test-pkg-bench-dd-c-vf-oss-template-v1.0.4` | `datadog-compromised` | `vf-oss-template@1.0.4` |
| `test-pkg-bench-dd-c-zuper-cli-v1.0.1` | `datadog-compromised` | `zuper-cli@1.0.1` |
| `test-pkg-bench-dd-m-bolt-new-v0.0.0-dev-202603280606` | `datadog-malicious-intent` | `bolt-new@0.0.0-dev-202603280606` |
| `test-pkg-bench-dd-m-delta666-v1.2.0` | `datadog-malicious-intent` | `delta666@1.2.0` |
| `test-pkg-bench-dd-m-fajar-rujak4-ruro-v2.4.2` | `datadog-malicious-intent` | `fajar-rujak4-ruro@2.4.2` |
| `test-pkg-bench-dd-m-kurniawan-tumis50-sukiwir-v2.4.3` | `datadog-malicious-intent` | `kurniawan-tumis50-sukiwir@2.4.3` |
| `test-pkg-bench-dd-m-next-preconfig-v1.0.0` | `datadog-malicious-intent` | `next-preconfig@1.0.0` |
| `test-pkg-bench-dd-m-redirect-4r6ynv-v1.0.0` | `datadog-malicious-intent` | `redirect-4r6ynv@1.0.0` |
| `test-pkg-bench-dd-m-wicked-executor-v2.0.1` | `datadog-malicious-intent` | `wicked-executor@2.0.1` |

## SAFE Misses

These 26 rows returned `SAFE` even though Datadog ground truth expects
`DANGEROUS`.

| Fixture | Category | Package |
| --- | --- | --- |
| `test-pkg-bench-dd-c-capacitor-plugin-ihealth-v1.1.9` | `datadog-compromised` | `capacitor-plugin-ihealth@1.1.9` |
| `test-pkg-bench-dd-c-cordova-plugin-voxeet2-v1.0.24` | `datadog-compromised` | `cordova-plugin-voxeet2@1.0.24` |
| `test-pkg-bench-dd-c-ember-headless-table-v2.1.6` | `datadog-compromised` | `ember-headless-table@2.1.6` |
| `test-pkg-bench-dd-c-ember-velcro-v2.2.1` | `datadog-compromised` | `ember-velcro@2.2.1` |
| `test-pkg-bench-dd-c-gate-evm-tools-test-v1.0.6` | `datadog-compromised` | `gate-evm-tools-test@1.0.6` |
| `test-pkg-bench-dd-c-is-arrayish-v0.3.3` | `datadog-compromised` | `is-arrayish@0.3.3` |
| `test-pkg-bench-dd-c-mgc-v1.2.2` | `datadog-compromised` | `mgc@1.2.2` |
| `test-pkg-bench-dd-c-pm2-gelf-json-v1.0.4` | `datadog-compromised` | `pm2-gelf-json@1.0.4` |
| `test-pkg-bench-dd-m-0xmisoke-v1.0.0` | `datadog-malicious-intent` | `0xmisoke@1.0.0` |
| `test-pkg-bench-dd-m-b3dtiles-sample-v1.0.0` | `datadog-malicious-intent` | `b3dtiles-sample@1.0.0` |
| `test-pkg-bench-dd-m-badgekit-api-client-v9.9.0` | `datadog-malicious-intent` | `badgekit-api-client@9.9.0` |
| `test-pkg-bench-dd-m-bc-nuxt-vue-starter-v1.0.1` | `datadog-malicious-intent` | `bc-nuxt-vue-starter@1.0.1` |
| `test-pkg-bench-dd-m-eclipse-tractusx-github-io-v1.0.0` | `datadog-malicious-intent` | `eclipse-tractusx-github-io@1.0.0` |
| `test-pkg-bench-dd-m-epic-common-v1.0.0` | `datadog-malicious-intent` | `epic-common@1.0.0` |
| `test-pkg-bench-dd-m-icinga-v99.99.2` | `datadog-malicious-intent` | `icinga@99.99.2` |
| `test-pkg-bench-dd-m-mahesa-mangut14-sluey-v3.3.4` | `datadog-malicious-intent` | `mahesa-mangut14-sluey@3.3.4` |
| `test-pkg-bench-dd-m-model-viewer-render-fidelity-tools-v99.99.99` | `datadog-malicious-intent` | `model-viewer-render-fidelity-tools@99.99.99` |
| `test-pkg-bench-dd-m-mrxfunc-v9.9.6` | `datadog-malicious-intent` | `mrxfunc@9.9.6` |
| `test-pkg-bench-dd-m-msl-example-client-v1.0.0` | `datadog-malicious-intent` | `msl-example-client@1.0.0` |
| `test-pkg-bench-dd-m-nintendoamerica-ncom-v1.0.2` | `datadog-malicious-intent` | `nintendoamerica-ncom@1.0.2` |
| `test-pkg-bench-dd-m-pbr-client-v99.99.2` | `datadog-malicious-intent` | `pbr-client@99.99.2` |
| `test-pkg-bench-dd-m-shopify-css-import-v1.0.0` | `datadog-malicious-intent` | `shopify-css-import@1.0.0` |
| `test-pkg-bench-dd-m-stardrop-linux-arm64-musl-v0.0.0-dev-202601291619` | `datadog-malicious-intent` | `stardrop-linux-arm64-musl@0.0.0-dev-202601291619` |
| `test-pkg-bench-dd-m-tilt-ui-v1.0.0` | `datadog-malicious-intent` | `tilt-ui@1.0.0` |
| `test-pkg-bench-dd-m-unwilling_egret_z3n-v2.2.1` | `datadog-malicious-intent` | `unwilling_egret_z3n@2.2.1` |
| `test-pkg-bench-dd-m-zul-lapis79-riris-v4.2.2` | `datadog-malicious-intent` | `zul-lapis79-riris@4.2.2` |

## Investigation Order

1. Re-run or recover the timeout rows first. They are infra uncertainty, not
   model misses.
2. Inspect SAFE misses by family:
   - `datadog-compromised`: likely low signal hidden in real package noise.
   - `datadog-malicious-intent`: likely prompt threshold or capability coverage
     gaps.
3. For every confirmed miss, classify the observed malicious behavior and add
   that class to the V3 mutator backlog.
