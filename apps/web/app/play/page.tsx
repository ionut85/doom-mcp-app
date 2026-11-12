import type { Metadata, Viewport } from "next";
import Player from "./Player";

export const metadata: Metadata = {
  title: "Play DOOM · doom-player",
  description: "Play Freedoom E1 in the browser on the same WebAssembly engine Claude plays.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0d0a09",
};

export default async function PlayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return <Player selftest={sp.selftest === "1"} />;
}
