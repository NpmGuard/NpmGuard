export function Benchmark() {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center"
      style={{ padding: 48 }}
    >
      <h1
        style={{
          fontFamily: "var(--font-heading)",
          fontSize: "1.6rem",
          fontWeight: 700,
          marginBottom: 12,
          letterSpacing: "-0.02em",
        }}
      >
        Benchmark
      </h1>
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: "0.88rem",
          fontFamily: "var(--font-mono)",
        }}
      >
        Coming soon — audit accuracy metrics and detection rates.
      </p>
    </div>
  );
}
