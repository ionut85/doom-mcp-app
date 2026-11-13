import type { Metadata } from "next";
import Replayer from "./Replayer";

export const metadata: Metadata = {
  title: "Replay: Claude clears E1M1 · doom-player",
  description: "A tic-exact replay of Claude Opus 5.5 finishing Freedoom E1M1, with its captions.",
};

export default async function ReplayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const run = sp.run === "skill2" ? "skill2" : "skill3";
  return <Replayer initialRun={run} />;
}
