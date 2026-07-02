"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const CORE_BASE_URL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";

const QUALITY_PRESETS = {
  high: { label: "High quality", crf: 23 },
  medium: { label: "Balanced", crf: 28 },
  low: { label: "Smallest size", crf: 34 },
} as const;

type QualityKey = keyof typeof QUALITY_PRESETS;

const RESOLUTIONS = {
  original: { label: "Original", scale: null },
  "1080": { label: "1080p", scale: "1920:-2" },
  "720": { label: "720p", scale: "1280:-2" },
  "480": { label: "480p", scale: "854:-2" },
} as const;

type ResolutionKey = keyof typeof RESOLUTIONS;

type QueueStatus = "queued" | "compressing" | "done" | "error";

type QueueItem = {
  id: string;
  file: File;
  status: QueueStatus;
  progress: number;
  resultUrl?: string;
  resultSize?: number;
  resultName?: string;
  error?: string;
};

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function FileIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-zinc-500">
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 8h18M8 3v18" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
      <path
        d="M8 18h8a4 4 0 0 0 .5-7.97 5.5 5.5 0 0 0-10.6-1.5A4.5 4.5 0 0 0 6.5 17"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 20v-7m0 0-2.5 2.5M12 13l2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function VideoCompressor() {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const [loadingCore, setLoadingCore] = useState(false);
  const [coreReady, setCoreReady] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [quality, setQuality] = useState<QualityKey>("medium");
  const [resolution, setResolution] = useState<ResolutionKey>("original");
  const [batchRunning, setBatchRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const queueRef = useRef<QueueItem[]>([]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const progressHandlerRef = useRef<(p: number) => void>(() => {});

  const updateItem = (id: string, patch: Partial<QueueItem>) => {
    setQueue((q) => q.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  const ensureCoreLoaded = useCallback(async () => {
    if (ffmpegRef.current && coreReady) return ffmpegRef.current;
    setLoadingCore(true);
    setLoadError(null);
    try {
      const ffmpeg = new FFmpeg();
      ffmpeg.on("progress", ({ progress: p }) => {
        progressHandlerRef.current(Math.min(100, Math.max(0, Math.round(p * 100))));
      });
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
        classWorkerURL: new URL("/ffmpeg/worker.js", window.location.origin).href,
      });
      ffmpegRef.current = ffmpeg;
      setCoreReady(true);
      return ffmpeg;
    } catch (e) {
      setLoadError("Failed to load the compression engine. Check your connection and try again.");
      throw e;
    } finally {
      setLoadingCore(false);
    }
  }, [coreReady]);

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const items: QueueItem[] = Array.from(files)
      .filter((f) => f.type.startsWith("video/"))
      .map((f) => ({ id: makeId(), file: f, status: "queued", progress: 0 }));
    if (items.length === 0) return;
    setQueue((q) => [...q, ...items]);
  };

  const removeItem = (id: string) => {
    setQueue((q) => q.filter((it) => it.id !== id));
  };

  const clearQueue = () => {
    setQueue((q) => q.filter((it) => it.status === "compressing"));
  };

  const compressOne = async (item: QueueItem) => {
    updateItem(item.id, { status: "compressing", progress: 0, error: undefined });
    try {
      const ffmpeg = await ensureCoreLoaded();
      progressHandlerRef.current = (p) => updateItem(item.id, { progress: p });

      const inputName = "input-" + item.id + (item.file.name.match(/\.[^.]+$/)?.[0] ?? ".mp4");
      const outputName = "output-" + item.id + ".mp4";

      await ffmpeg.writeFile(inputName, await fetchFile(item.file));

      const args = ["-i", inputName];
      const scale = RESOLUTIONS[resolution].scale;
      if (scale) {
        args.push("-vf", `scale=${scale}`);
      }
      args.push(
        "-c:v",
        "libx264",
        "-crf",
        String(QUALITY_PRESETS[quality].crf),
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        outputName
      );

      await ffmpeg.exec(args);

      const data = await ffmpeg.readFile(outputName);
      const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);

      updateItem(item.id, {
        status: "done",
        progress: 100,
        resultUrl: url,
        resultSize: blob.size,
        resultName: item.file.name.replace(/\.[^.]+$/, "") + "-compressed.mp4",
      });

      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
    } catch (e) {
      console.error(e);
      updateItem(item.id, {
        status: "error",
        error: "Compression failed for this file.",
      });
    }
  };

  const compressAll = async () => {
    setBatchRunning(true);
    try {
      let next = queueRef.current.find((it) => it.status === "queued");
      while (next) {
        await compressOne(next);
        next = queueRef.current.find((it) => it.status === "queued");
      }
    } finally {
      setBatchRunning(false);
    }
  };

  const [isDragOver, setIsDragOver] = useState(false);

  const queuedCount = queue.filter((it) => it.status === "queued").length;
  const hasQueued = queuedCount > 0;

  return (
    <div className="w-full max-w-xl mx-auto bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-100 dark:border-zinc-800 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_10px_-2px_rgba(0,0,0,0.3)] p-6 flex flex-col gap-5 animate-fade-in-up">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-medium tracking-tighter text-zinc-900 dark:text-zinc-50">
            Compress video files
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1.5">
            Compress large videos entirely in your browser. Nothing is uploaded anywhere.
          </p>
        </div>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="text-zinc-300 shrink-0 mt-1 transition-transform duration-500 ease-out hover:rotate-45 hover:scale-125 hover:text-zinc-400"
        >
          <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
        </svg>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-mono font-medium tracking-wide text-zinc-500 dark:text-zinc-400">
            QUALITY
          </label>
          <div className="relative">
            <select
              className="w-full appearance-none rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-3 pr-9 py-2 text-sm transition-all duration-150 outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-100/20 hover:border-zinc-300 dark:hover:border-zinc-600"
              value={quality}
              onChange={(e) => setQuality(e.target.value as QualityKey)}
              disabled={batchRunning}
            >
              {Object.entries(QUALITY_PRESETS).map(([key, val]) => (
                <option key={key} value={key}>
                  {val.label}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-zinc-400">
              <ChevronIcon />
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-mono font-medium tracking-wide text-zinc-500 dark:text-zinc-400">
            RESOLUTION
          </label>
          <div className="relative">
            <select
              className="w-full appearance-none rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-3 pr-9 py-2 text-sm transition-all duration-150 outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-100/20 hover:border-zinc-300 dark:hover:border-zinc-600"
              value={resolution}
              onChange={(e) => setResolution(e.target.value as ResolutionKey)}
              disabled={batchRunning}
            >
              {Object.entries(RESOLUTIONS).map(([key, val]) => (
                <option key={key} value={key}>
                  {val.label}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-zinc-400">
              <ChevronIcon />
            </span>
          </div>
        </div>
      </div>

      <label
        className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed py-9 cursor-pointer transition-all duration-200 ${
          isDragOver
            ? "border-zinc-500 dark:border-zinc-400 bg-zinc-50 dark:bg-zinc-800/60 scale-[1.01]"
            : "border-zinc-300 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500 hover:bg-zinc-50/60 dark:hover:bg-zinc-800/40"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <input
          type="file"
          accept="video/*"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div
          className={`relative flex items-center justify-center w-14 h-14 rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-sm text-zinc-400 transition-transform duration-300 ${
            isDragOver ? "scale-110 -translate-y-0.5 text-zinc-600 dark:text-zinc-200" : ""
          }`}
        >
          <UploadIcon />
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          <span className="font-medium underline underline-offset-2">Click to upload</span> or drag
          and drop
        </p>
        <p className="text-xs text-zinc-400">Add as many videos as you like — they'll queue up</p>
      </label>

      {loadError && (
        <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 rounded-lg px-3 py-2">
          {loadError}
        </p>
      )}

      {queue.length > 0 && (
        <div className="flex flex-col gap-2 max-h-80 overflow-y-auto pr-1">
          {queue.map((item) => (
            <div
              key={item.id}
              className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 flex flex-col gap-2 animate-fade-in-up transition-shadow duration-200 hover:shadow-sm"
            >
              <div className="flex items-start gap-3">
                <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-100 dark:bg-zinc-800 shrink-0">
                  <FileIcon />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate">
                    {item.file.name}
                  </p>
                  <p className="text-xs font-mono text-zinc-400">{formatBytes(item.file.size)}</p>
                </div>
                {item.status !== "compressing" && (
                  <button
                    onClick={() => removeItem(item.id)}
                    className="text-zinc-400 p-1 shrink-0 rounded-md"
                    aria-label={`Remove ${item.file.name}`}
                  >
                    <XIcon />
                  </button>
                )}
              </div>

              {item.status === "done" && item.resultUrl && item.resultSize != null ? (
                <div className="flex items-center justify-between gap-3 pl-12">
                  <span className="flex items-center gap-1.5 text-xs font-mono text-green-600 dark:text-green-400">
                    <span className="animate-pop-in">
                      <CheckIcon />
                    </span>
                    {formatBytes(item.resultSize)}
                    {" · "}
                    {Math.round((1 - item.resultSize / item.file.size) * 100)}% smaller
                  </span>
                  <a
                    href={item.resultUrl}
                    download={item.resultName}
                    className="text-xs font-medium rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 shrink-0"
                  >
                    Download
                  </a>
                </div>
              ) : item.status === "error" ? (
                <p className="text-xs text-red-600 dark:text-red-400 pl-12">{item.error}</p>
              ) : (
                <div className="flex items-center gap-2 pl-12">
                  <div className="flex-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                    <div
                      className={`relative h-full transition-all duration-200 overflow-hidden ${
                        item.status === "compressing" ? "bg-zinc-900 dark:bg-zinc-100" : "bg-zinc-300 dark:bg-zinc-700"
                      }`}
                      style={{ width: `${item.progress}%` }}
                    >
                      {item.status === "compressing" && (
                        <div className="absolute inset-0 animate-shimmer" />
                      )}
                    </div>
                  </div>
                  <span className="text-xs font-mono text-zinc-400 w-16 text-right">
                    {item.status === "queued" ? "Waiting" : `${item.progress}%`}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-1 border-t border-zinc-100 dark:border-zinc-800 mt-1">
        <button
          onClick={clearQueue}
          disabled={queue.length === 0 || batchRunning}
          className="rounded-xl border border-zinc-300 dark:border-zinc-700 px-5 py-3 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Clear all
        </button>
        <button
          onClick={compressAll}
          disabled={!hasQueued || batchRunning || loadingCore}
          className="rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-5 py-3 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loadingCore
            ? "Loading engine…"
            : batchRunning
              ? "Compressing…"
              : queuedCount > 0
                ? `Compress ${queuedCount} file${queuedCount > 1 ? "s" : ""}`
                : "Compress all"}
        </button>
      </div>
    </div>
  );
}
