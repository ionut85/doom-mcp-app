export const metadata = { title: "doom-player", description: "Claude plays DOOM, inline, as an MCP App." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#111", color: "#eee", margin: 0 }}>{children}</body>
    </html>
  );
}
