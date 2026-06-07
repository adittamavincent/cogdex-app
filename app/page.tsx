export default function Home() {
  const isDev = process.env.NODE_ENV !== "production";

  return (
    <main style={{ padding: 48, display: "flex", justifyContent: "center" }}>
      <div style={{ maxWidth: 880 }}>
        <h1>Welcome to Cogdex</h1>
        {isDev ? (
          <p>
            Cogdex is running.
          </p>
        ) : null}
      </div>
    </main>
  );
}
