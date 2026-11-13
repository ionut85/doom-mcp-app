"use client";

// Plays a saved Claude run tic by tic at DOOM's speed, with Claude's captions
// burned into the picture, and can record the canvas to a WebM video.
// The run is an input log: DOOM is deterministic, so this is exactly the game Claude played.

import { useEffect, useRef, useState } from "react";
import type { Engine, TicStep } from "@doom-player/doom-core/core";
import { loadEngine } from "@/lib/play/load";
import s from "./replay.module.css";

type Run = {
  title: string; model: string; effort: string; perception: string; skill: number; episode: number; map: number;
  actions: number; kills: number; total_kills: number; cost_usd: number; date: string; total_tics: number;
  steps: [number, number, number, number, number][];
  captions: { tic: number; text: string }[];
};

const RUNS: Record<string, { file: string; label: string }> = {
  skill3: { file: "/replays/e1m1-skill3.json", label: "Skill 3 · Hurt me plenty (140 moves)" },
  skill2: { file: "/replays/e1m1-skill2.json", label: "Skill 2 · Hey, not too rough (74 moves)" },
};
const TIC_MS = 1000 / 35;
const W = 960, H = 720; // 4:3 output, like the original monitor

export default function Replayer({ initialRun }: { initialRun: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [runKey, setRunKey] = useState(initialRun);
  const [run, setRun] = useState<Run | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [recording, setRecording] = useState(false);
  const [download, setDownload] = useState<string | null>(null);
  const [gen, setGen] = useState(0); // bump to restart
  const ctl = useRef({ playing: false, speed: 1 });
  ctl.current.playing = playing;
  ctl.current.speed = speed;
  const recorder = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    (async () => {
      setStatus("Loading…");
      const r: Run = await (await fetch(RUNS[runKey]!.file)).json();
      if (cancelled) return;
      setRun(r);
      const engine: Engine = await loadEngine({ skill: r.skill, episode: r.episode, map: r.map });
      if (cancelled) return;
      const base = engine.getState().gametic;
      const queue: TicStep[] = r.steps.map(([f, s2, t, b, n]) => ({ f, s: s2, t, b, n }));
      const src = document.createElement("canvas");
      src.width = engine.width;
      src.height = engine.height;
      const sctx = src.getContext("2d")!;
      const img = sctx.createImageData(engine.width, engine.height);
      const out = canvasRef.current!;
      out.width = W;
      out.height = H;
      const ctx = out.getContext("2d", { alpha: false })!;

      const draw = () => {
        img.data.set(engine.render());
        sctx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(src, 0, 0, W, H);
        const st = engine.getState();
        const tic = st.gametic;
        // Caption: the latest one whose move has started (captions are stamped at the move's end tic).
        const idx = r.captions.findIndex((c) => c.tic >= tic);
        const cap = r.captions[idx === -1 ? r.captions.length - 1 : idx];
        const move = idx === -1 ? r.captions.length : idx + 1;
        ctx.fillStyle = "rgba(13,10,9,.72)";
        ctx.fillRect(0, 0, W, 54);
        ctx.font = "600 24px system-ui, -apple-system, sans-serif";
        ctx.fillStyle = "#eee4da";
        ctx.textBaseline = "middle";
        if (cap) ctx.fillText(`Claude: ${cap.text}`, 18, 27, W - 220);
        ctx.font = "500 18px ui-monospace, Menlo, monospace";
        ctx.fillStyle = "#e7a83e";
        ctx.textAlign = "right";
        ctx.fillText(`move ${Math.min(move, r.actions)}/${r.actions}`, W - 18, 27);
        ctx.textAlign = "left";
        if (st.gamestate === "intermission") {
          ctx.fillStyle = "rgba(13,10,9,.78)";
          ctx.fillRect(0, H * 0.4, W, 90);
          ctx.font = "800 44px system-ui, sans-serif";
          ctx.fillStyle = "#6cc07a";
          ctx.textAlign = "center";
          ctx.fillText("LEVEL COMPLETE", W / 2, H * 0.4 + 45);
          ctx.textAlign = "left";
        }
        setStatus(`game time ${(tic - base) / 35 >= 0 ? ((tic - base) / 35).toFixed(1) : "0.0"} s · kills ${st.kills}/${st.totalKills} · health ${st.health}`);
      };
      draw();
      setStatus("Ready");
      let last = performance.now(), acc = 0, held = 0;
      const frame = (now: number) => {
        if (cancelled) return;
        const dt = Math.min(now - last, 250);
        last = now;
        if (ctl.current.playing && queue.length) {
          acc += dt * ctl.current.speed;
          let ran = 0;
          while (acc >= TIC_MS && queue.length) {
            const head = queue[0]!;
            engine.applyTicStep({ ...head, n: 1 });
            if (--head.n <= 0) queue.shift();
            acc -= TIC_MS;
            ran++;
          }
          if (ran) draw();
          if (!queue.length) held = now;
        } else if (!queue.length && ctl.current.playing && now - held > 2500) {
          // Hold the final frame a moment, then stop (and finish a recording).
          setPlaying(false);
          if (recorder.current?.state === "recording") recorder.current.stop();
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    })().catch((e) => setStatus(`Couldn't load the replay: ${e instanceof Error ? e.message : e}`));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [runKey, gen]);

  function restart(autoplay = false) {
    setDownload(null);
    setPlaying(autoplay);
    setGen((g) => g + 1);
  }

  function record() {
    const canvas = canvasRef.current!;
    if (typeof MediaRecorder === "undefined" || !canvas.captureStream) {
      setStatus("This browser can't record the canvas. Use a screen recorder instead.");
      return;
    }
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    const stream = canvas.captureStream(35);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      setRecording(false);
      setDownload(URL.createObjectURL(new Blob(chunks, { type: rec.mimeType })));
    };
    recorder.current = rec;
    restart(true);
    // Start once the restarted engine has drawn its first frame.
    setTimeout(() => {
      rec.start(1000);
      setRecording(true);
    }, 600);
  }

  const ext = recorder.current?.mimeType.includes("mp4") ? "mp4" : "webm";
  return (
    <main className={s.page}>
      <div className={s.inner}>
        <h1 className={s.title}>
          {run?.title ?? "Replay"} <a href="/">· doom-player</a>
        </h1>
        {run && (
          <p className={s.meta}>
            {run.model} at {run.effort} effort, {run.perception === "both" ? "screenshot + state" : run.perception} perception · {run.actions} moves · {run.kills}/{run.total_kills} kills · API cost ${run.cost_usd.toFixed(2)} · {run.date.slice(0, 10)}
          </p>
        )}
        <div className={s.screen}>
          <canvas ref={canvasRef} width={W} height={H} aria-label="Replay of Claude playing DOOM" />
        </div>
        <div className={s.controls}>
          <button type="button" className={s.primary} onClick={() => setPlaying((p) => !p)} disabled={recording}>
            {playing ? "Pause" : "Play"}
          </button>
          <button type="button" onClick={() => restart(false)} disabled={recording}>Restart</button>
          <select id="speed" aria-label="Speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={recording}>
            <option value={0.5}>0.5×</option>
            <option value={1}>1× (real speed)</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
          <select id="run" aria-label="Run" value={runKey} onChange={(e) => (setRunKey(e.target.value), restart(false))} disabled={recording}>
            {Object.entries(RUNS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <button type="button" className={s.rec} onClick={record} disabled={recording}>
            {recording ? "Recording…" : "Record video"}
          </button>
          {download && (
            <a className={s.download} href={download} download={`claude-doom-e1m1-${runKey}.${ext}`}>
              Download video
            </a>
          )}
          <span className={s.status}>{status}</span>
        </div>
        <p className={s.note}>
          Every frame is recomputed in your browser from Claude&apos;s recorded inputs. DOOM is deterministic, so this is exactly the game Claude played, including where it paused to think. Real speed shows game time only: the game was frozen while Claude thought between moves, which took several minutes of real time.
        </p>
      </div>
    </main>
  );
}
