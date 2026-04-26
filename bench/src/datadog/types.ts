// ---------------------------------------------------------------------------
// Datadog corpus types — shapes that mirror what's actually on disk in the
// public Datadog Malicious Software Packages Dataset.
//
// https://github.com/DataDog/malicious-software-packages-dataset
//
// Manifest format (samples/npm/manifest.json):
//   {
//     "package-name": null,                // malicious_intent: every version is bad
//     "other-package": ["1.0.0", "1.0.1"]  // compromised_lib: only these versions
//   }
//
// On-disk layout per sample:
//   samples/npm/<class>/<name>/<version>/<YYYY-MM-DD>-<name>-v<version>.zip
//
// The class is `compromised_lib` or `malicious_intent`, derived from whether
// the manifest entry is an array or null.
// ---------------------------------------------------------------------------

export type DatadogClass = "compromised_lib" | "malicious_intent";

/** A single sample in the corpus, fully addressable. */
export interface DatadogSample {
  packageName: string;
  version: string;
  className: DatadogClass;
  /** YYYY-MM-DD discovery date parsed from the ZIP filename. */
  discoveryDate: string;
  /** Filename of the ZIP, e.g. "2025-11-24-02-echo-v0.0.7.zip". */
  zipFilename: string;
  /** Raw GitHub URL where the ZIP can be downloaded. */
  zipUrl: string;
}

/** The selection produced by the corpus selector — a stratified sample. */
export interface DatadogCorpus {
  /** Commit SHA of the dataset repo at selection time (for reproducibility). */
  datasetCommitSha: string;
  /** Date selection was run, for the manifest. */
  selectedAt: string;
  /** Random seed used for sampling. */
  seed: number;
  /** Total sample count in the source manifest at selection time. */
  totalSamplesInDataset: number;
  /** Number sampled per class. */
  sampledPerClass: Record<DatadogClass, number>;
  samples: DatadogSample[];
}
