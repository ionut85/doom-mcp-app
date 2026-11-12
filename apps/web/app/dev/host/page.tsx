import { notFound } from "next/navigation";
import HostHarness from "./HostHarness";

export const metadata = { title: "MCP App host harness · doom-player" };

// Dev-only: a minimal MCP Apps host for testing the viewer locally.
export default function Page() {
  if (process.env.NODE_ENV === "production" && !process.env.DOOM_DEV_HOST) notFound();
  return <HostHarness />;
}
