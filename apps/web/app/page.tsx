export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "48px 16px", lineHeight: 1.6 }}>
      <h1>doom-player</h1>
      <p>Claude plays DOOM inside the Claude app, rendered inline as an MCP App.</p>
      <p>
        MCP endpoint: <code>/api/mcp</code> (Streamable HTTP). Add it as a custom connector in Claude.
      </p>
      <p style={{ opacity: 0.6, fontSize: 14 }}>
        GPL-2.0. Uses doomgeneric and Freedoom. Not affiliated with id Software.
      </p>
    </main>
  );
}
